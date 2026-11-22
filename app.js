import {
  addCards, balance, cleanDigits, code128, daysLeft, expiryState, formatEuro as euroIn, groupNumber, isDate, isName, isoDate, isoWeek,
  needsInstall, parseEuro, parseState, periodStart, settle, shareOut, shiftPeriod, sortCards, summarize,
  validCode, validNumber,
} from './logic.js';
import {
  AH, START_CATS, US, addBalance, addFile, addStarter, balanceOn, byParty, cardsOn, catchUp, decodeText, dueOn, emptyBank, figures, fixedCosts,
  fixedSuggestions, forWhom, giftGuesses, giftsBought, giftsToFill, hasGap, heldShops, inCategory, monthOf, parseBank, payFrom, readCsv,
  readOpenbank, ruleKey, shiftMonth, sorter,
} from './bank.js';
import {
  api, b64u, fromB64u, inviteId, isCode, makePasskey, merge, openData, rand, sealData, tokenOf, unwrap, usePasskey, wrap,
} from './sync.js';

const KEY = 'ah-saldo'; // the app's first name; changing this key would hide everything already saved
const BANK_KEY = `${KEY}-bank`; // apart from the cards, so nothing in the bank data can ever make the cards unreadable
// Dutch unless English was chosen on this phone. L(dutch, english) picks the text; switching reloads the app.
const lang = localStorage.getItem(`${KEY}-lang`) === 'en' ? 'en' : 'nl';
const L = (nl, en) => (lang === 'en' ? en : nl);
const LOCALE = L('nl-NL', 'en-GB');
// an amount below zero is written with a true minus sign in front, everywhere
const formatEuro = (cents) => (cents < 0 ? `− ${euroIn(-cents, LOCALE)}` : euroIn(cents, LOCALE));
// AH's official "Saldochecker AH cadeaukaart" link, as published on ah.nl
const CHECKER = 'https://service2.loyaltyinabox.com/CardBalanceChecker/2/paymentapi.aspx?cmd=showbalance&username=1379001&lang=nl-NL';
const KIND = { start: L('Beginsaldo', 'Starting balance'), pay: L('Betaling', 'Payment'), correct: L('Correctie', 'Correction') };
const SHOPS = ['AH', 'Plus', 'Jumbo', 'Dirk', 'Lidl', 'Anders'];
// the default names are saved in Dutch, so a language switch leaves the data alone
const ENGLISH_NAMES = new Map([
  [US, 'Us'], ['Anders', 'Other'], ['Boodschappen', 'Groceries'], ['Uit eten', 'Eating out'], ['Abonnementen', 'Subscriptions'],
  ['Auto & vervoer', 'Car & transport'], ['Verzekering & zorg', 'Insurance & health'], ['Winkelen', 'Shopping'], ['Cadeaukaarten', 'Gift cards'],
  ['Reizen', 'Travel'], ['Voor anderen', 'For others'], ['Overig', 'Other'], ['Salaris', 'Salary'], ['Overig inkomen', 'Other income'],
  ['Overboeking', 'Transfer'], ['Werk & bedrijf', 'Work & business'], ['Aflossing lening', 'Loan repayment'],
  ['Creditcard (Amex)', 'Credit card (Amex)'],
]);
const shown = (name) => (lang === 'en' && ENGLISH_NAMES.get(name)) || name;
const UNITS = { week: 'Week', month: L('Maand', 'Month'), year: L('Jaar', 'Year') };
const SPAN = { week: 8, month: 6, year: 4 }; // how many periods the chart shows
const STALE = 30; // days after which the overview asks for new bank files
const START_IDS = new Set(START_CATS.map((cat) => cat.id));
const KIND_ORDER = ['out', 'in', 'none'];

const $ = (id) => document.getElementById(id);
const app = $('app');
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let state; // the gift cards and what was paid with them
let bank; // accounts, transactions, categories and rules

// ---------- storage ----------

function load() {
  const empty = { cards: [], purchases: [], needsBackup: false };
  const raw = localStorage.getItem(KEY);
  if (!raw) return empty;
  try {
    return parseState(raw);
  } catch {
    // move the unreadable data to another key, so the next save cannot overwrite it
    localStorage.setItem(`${KEY}-onleesbaar-${Date.now()}`, raw);
    localStorage.removeItem(KEY);
    toast(L('De opgeslagen kaarten zijn onleesbaar. Zet een back-up terug.', 'The saved cards cannot be read. Restore a backup.'));
    return empty;
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    toast(L('Opslaan is mislukt. Maak nu een back-up.', 'Saving failed. Make a backup now.'));
  }
  render();
  syncSoon();
}

function loadBank() {
  const raw = localStorage.getItem(BANK_KEY);
  if (!raw) return emptyBank();
  try {
    return parseBank(JSON.parse(raw));
  } catch {
    try { localStorage.setItem(`${BANK_KEY}-onleesbaar-${Date.now()}`, raw); } catch { /* no room for a second copy */ }
    localStorage.removeItem(BANK_KEY);
    toast(L('De bankgegevens zijn onleesbaar. Upload de bestanden opnieuw.', 'The bank data cannot be read. Upload the files again.'));
    return emptyBank();
  }
}

function saveBank() {
  try {
    localStorage.setItem(BANK_KEY, JSON.stringify(bank));
  } catch {
    toast(L('Opslaan is mislukt: de opslag van de telefoon is vol.', 'Saving failed: the storage of the phone is full.'));
  }
  render();
  syncSoon();
}

// ---------- sharing ----------
// With sharing on, the cards and bank data are also on the Kassa server, locked (see sync.js), and every phone
// keeps its own full copy, as a shop may have no signal. Changes go up a moment after they are saved; the other
// phone fetches them when Kassa opens or comes back to the front, and every ten seconds while it is on screen.

const SHARE_KEY = `${KEY}-sync`; // { key: the household key, cred: this phone's passkey, version: of the data last synced }
const BASE_KEY = `${KEY}-sync-base`; // the data as it was after the last sync: what changed on both sides since is joined
let sharing = readSharing();
let household = sharing && fromB64u(sharing.key);
let syncing = false;
let syncAgain = false;
let syncError = null;
let syncTimer;

function readSharing() {
  try {
    const saved = JSON.parse(localStorage.getItem(SHARE_KEY));
    return saved?.key ? saved : null;
  } catch {
    return null;
  }
}

// The data in one fixed form: the readers write every field in the same order, so two copies compare as text.
// They also refuse data that is not Kassa's, whatever the server sends.
const canonical = (data) => ({ state: parseState(JSON.stringify(data.state)), bank: parseBank(data.bank) });
const snapshot = () => JSON.stringify(canonical({ state, bank }));

function keepSharing(base) {
  localStorage.setItem(SHARE_KEY, JSON.stringify(sharing));
  localStorage.setItem(BASE_KEY, base);
}

// Puts `data` (canonical) in the app in place of what was there, and saves it on this phone.
function takeData(data) {
  ({ state, bank } = data);
  localStorage.setItem(KEY, JSON.stringify(state));
  localStorage.setItem(BANK_KEY, JSON.stringify(bank));
}

// A sheet is open or a field has the keyboard: replacing the data now would undo what is being entered.
const busy = () => Boolean(document.querySelector('dialog[open]'))
  || (app.contains(document.activeElement) && document.activeElement.matches('input, select, textarea'));

function syncSoon() {
  if (!sharing) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 1500);
}

// Brings this phone and the server level: fetches what is new there, joins it with what changed here, and sends
// the result. One run at a time; a call during a run makes it run once more.
async function sync(tries = 3) {
  if (!sharing) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  syncAgain = false;
  let changed = false;
  const failed = Boolean(syncError);
  try {
    const token = await tokenOf(household);
    const remote = await api('GET', `/vault?have=${sharing.version}`, { token });
    if (remote) {
      if (busy()) return; // the next round tries again
      const theirs = canonical(JSON.parse(await openData(household, remote.data)));
      const mine = snapshot();
      const base = localStorage.getItem(BASE_KEY);
      takeData(mine === base ? theirs : canonical(merge(JSON.parse(base), JSON.parse(mine), theirs)));
      sharing.version = remote.version;
      keepSharing(JSON.stringify(theirs));
      changed = true;
    }
    const now = snapshot();
    if (now !== localStorage.getItem(BASE_KEY)) {
      const sent = await api('PUT', '/vault', { token, body: { base: sharing.version, data: await sealData(household, now) } })
        .catch((error) => {
          if (error.status === 409) return null; // the other phone was first: fetch and join once more
          throw error;
        });
      if (sent) {
        sharing.version = sent.version;
        keepSharing(now);
      } else syncAgain = true;
    }
    syncError = null;
  } catch (error) {
    syncError = error;
  } finally {
    syncing = false;
  }
  // the settings screen says whether the server is reachable; redrawing it every round would close its date picker
  if (changed || (route() === 'meer' && failed !== Boolean(syncError))) render();
  if (syncAgain && tries > 1) await sync(tries - 1);
}

// Starts sharing on this phone with household key `key`, the data in the app being version `version`.
function link(key, cred, version) {
  household = key;
  sharing = { key: b64u(key), cred, version };
  keepSharing(snapshot());
  syncError = null;
  render();
}

// Replaces what is on this phone with the shared data, and shares from then on.
async function joinWith(key, cred) {
  const remote = await api('GET', '/vault?have=0', { token: await tokenOf(key) });
  takeData(canonical(JSON.parse(await openData(key, remote.data))));
  link(key, cred, remote.version);
}

const said = (text) => Object.assign(new Error(text), { say: text });
const unless404 = (text) => (error) => {
  throw error.status === 404 ? said(text) : error;
};

// A passkey made with Face ID, with its key. Some phones hand the key out only on a second Face ID, which needs
// a tap of its own.
async function newPasskey() {
  const made = await makePasskey();
  if (made.secret) return made;
  if (!await ask(L('Nog één keer Face ID om de sleutel van de passkey op te halen.', 'One more Face ID to fetch the key of the passkey.'),
    L('Doorgaan', 'Continue'), true)) throw said(L('Delen is niet gestart.', 'Sharing has not started.'));
  return usePasskey(made.cred);
}

function shareError(error) {
  toast(error.say
    ?? (error.code === 'noprf' ? L('Deze telefoon geeft met Face ID geen sleutel: delen kan hier niet.', 'This phone gives no key with Face ID: sharing cannot work here.')
      : error.name === 'NotAllowedError' ? L('Face ID is gestopt. Probeer het opnieuw.', 'Face ID was stopped. Try again.')
        : error.status ? L('De Kassa-server weigerde dit.', 'The Kassa server refused this.')
          : L('Geen verbinding met de Kassa-server. Probeer het later opnieuw.', 'No connection with the Kassa server. Try again later.')));
}

// The first phone puts its data on the server; a phone whose passkey is there already (a new iPhone) fetches it.
async function startSharing() {
  try {
    const { ready } = await api('GET', '/status');
    if (!ready) {
      if (!await ask(L('Kassa maakt een passkey met Face ID en zet alles, op slot, op de Kassa-server. Alleen telefoons die jij uitnodigt kunnen het openen.',
        'Kassa makes a passkey with Face ID and puts everything, locked, on the Kassa server. Only phones you invite can open it.'), L('Delen', 'Share'), true)) return;
      const { cred, secret } = await newPasskey();
      const key = rand(32);
      const data = snapshot();
      await api('POST', '/setup', { body: { token: await tokenOf(key), cred, wrapped: await wrap(secret, 'kassa wrap', key), data: await sealData(key, data) } });
      link(key, cred, 1);
      toast(L('Delen staat aan. Nodig nu iemand uit.', 'Sharing is on. Now invite someone.'));
      return;
    }
    if (!await ask(L('Er wordt al gedeeld. Open de gedeelde gegevens met je Kassa-passkey? Ze vervangen wat nu op deze telefoon staat.',
      'Sharing has started already. Open the shared data with your Kassa passkey? It replaces what is on this phone now.'), L('Openen', 'Open'))) return;
    const { cred, secret } = await usePasskey();
    const { wrapped } = await api('GET', `/key/${cred}`).catch(unless404(L('Deze passkey hoort niet bij de gedeelde gegevens. Vraag om een uitnodigingscode.',
      'This passkey is not part of the shared data. Ask for an invite code.')));
    await joinWith(await unwrap(secret, 'kassa wrap', wrapped), cred);
    toast(L('De gedeelde gegevens staan erin.', 'The shared data is in.'));
  } catch (error) {
    shareError(error);
  }
}

async function joinSharing() {
  const code = await askText(L('Uitnodigingscode', 'Invite code'), L('Code', 'Code'), '', {
    max: 60, ok: L('Doorgaan', 'Continue'), check: (text) => (isCode(text) ? '' : L('Plak de hele code die je kreeg.', 'Paste the whole code you were sent.')),
  });
  if (code === null) return;
  try {
    const { wrapped } = await api('GET', `/invite/${await inviteId(code)}`)
      .catch(unless404(L('Deze code is gebruikt of verlopen. Vraag om een nieuwe.', 'This code was used or has expired. Ask for a new one.')));
    const key = await unwrap(fromB64u(code), 'kassa invite', wrapped);
    if (!await ask(L('Je maakt een passkey met Face ID. De gedeelde gegevens vervangen wat nu op deze telefoon staat: maak eerst een back-up als je dat wilt bewaren.',
      'You make a passkey with Face ID. The shared data replaces what is on this phone now: make a backup first if you want to keep it.'), L('Meedoen', 'Join'))) return;
    const { cred, secret } = await newPasskey();
    const token = await tokenOf(key);
    await api('POST', '/key', { token, body: { cred, wrapped: await wrap(secret, 'kassa wrap', key) } });
    await api('DELETE', '/invite', { token });
    await joinWith(key, cred);
    toast(L('Je deelt nu de gegevens.', 'You are sharing the data now.'));
  } catch (error) {
    shareError(error);
  }
}

async function invite() {
  try {
    const code = rand(16);
    const text = b64u(code);
    await api('PUT', '/invite', { token: await tokenOf(household), body: { id: await inviteId(text), wrapped: await wrap(code, 'kassa invite', household) } });
    // the share sheet needs a tap of its own, so the code is shown first
    if (!await ask(L(`Uitnodigingscode: ${text}. Stuur hem naar wie meedoet; hij werkt één keer, 24 uur lang.`,
      `Invite code: ${text}. Send it to whoever joins; it works once, for 24 hours.`), L('Code versturen', 'Send code'), true)) return;
    if (navigator.share) await navigator.share({ text }).catch(() => {}); // closing the share sheet is fine
    else {
      await navigator.clipboard.writeText(text);
      toast(L('Code gekopieerd.', 'Code copied.'));
    }
  } catch (error) {
    shareError(error);
  }
}

// ---------- building blocks ----------
// Card numbers, codes, dates, ids and amounts are safe to put in HTML by construction: the forms and
// parseState let nothing else in. Shop and person names are free text, so they always go through esc().
// Each screen returns its HTML and, optionally, the buttons for the dock at the thumb.

const esc = (text) => String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const last4 = (card) => `•••• ${card.number.slice(-4)}`;
const formatDate = (iso, timeZone) =>
  new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone });
const signed = (delta) => `${delta < 0 ? '−' : '+'} ${formatEuro(Math.abs(delta))}`;
const euroInput = (cents) => L((cents / 100).toFixed(2).replace('.', ','), (cents / 100).toFixed(2)); // an amount as it is typed: 12,50
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const ENTER_AMOUNT = L('Vul een bedrag in, bijvoorbeeld 12,50.', 'Enter an amount, for example 12.50.');
const ENTER_DATE = L('Vul een geldige datum in.', 'Enter a valid date.');

// months are 'YYYY-MM' and days 'YYYY-MM-DD', as in bank.js
const thisMonth = () => monthOf(isoDate());
const monthRange = (month) => [`${month}-01`, `${shiftMonth(month, 1)}-01`];
const monthDate = (month) => new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1);
const monthName = (month) => monthDate(month).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
const monthShort = (month) => monthDate(month).toLocaleDateString(LOCALE, { month: 'short' }).replace('.', '');
const dayShort = (day) => new Date(day).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');
const average = (list) => (list.length ? Math.round(list.reduce((sum, each) => sum + each, 0) / list.length) : 0);

const catById = (id) => bank.cats.find((cat) => cat.id === id);
const catName = (id) => (catById(id) ? esc(shown(catById(id).name)) : L('Nog indelen', 'To sort'));
const sortedCats = () => KIND_ORDER.flatMap((kind) => bank.cats.filter((cat) => cat.kind === kind));
const accountById = (id) => bank.accounts.find((account) => account.id === id);
// a shop's balance is an account too; it is named after the shop, in the language of the app
const nameOf = (account) => (account?.shop ? L(`${account.shop}-saldo`, `${account.shop} balance`) : account?.name ?? '');
const balanceOf = (shop) => bank.accounts.find((account) => account.shop === shop);
const monthFigures = (month) => figures(bank, state.purchases, ...monthRange(month));
const cardTotal = () => state.cards.reduce((sum, card) => sum + Math.max(balance(card), 0), 0);

// What the screens of the bank side are looking at. It lasts until the app is closed.
const view = { month: thisMonth(), unit: 'month', worth: '', query: '', cat: 'all', acc: 'all', rows: 60 };

const cardById = (id) => state.cards.find((card) => card.id === id);
const purchaseById = (id) => state.purchases.find((purchase) => purchase.id === id);
// the defaults first, then what has been used so far, most recent first
const listed = (defaults, used) => [...new Set([...defaults, ...used.reverse()])];
const people = () => listed([US], [...state.purchases, ...bank.txs].flatMap((each) => (each.shares ?? []).map((share) => share.who)));
const whoText = (purchase) => purchase.shares.map((share) => shown(share.who)).join(', ');

function expiryLabel(card) {
  if (!card.expiry) return '';
  const days = daysLeft(card.expiry, isoDate());
  const date = formatDate(card.expiry, 'UTC');
  if (days < 0) return L(`Verlopen op ${date}`, `Expired on ${date}`);
  if (days === 0) return L('Verloopt vandaag', 'Expires today');
  if (days <= 30) return L(`Verloopt over ${plural(days, 'dag', 'dagen')}`, `Expires in ${plural(days, 'day', 'days')}`);
  return L(`Geldig tot ${date}`, `Valid until ${date}`);
}

// plain text while there is time, a coloured pill once the date needs attention
function expiryHtml(card) {
  const label = expiryLabel(card);
  const urgency = expiryState(card.expiry, isoDate());
  if (!label) return '';
  return urgency === 'ok' ? `<span class="when">${label}</span>` : `<span class="pill ${urgency}">${label}</span>`;
}

// The card number as the barcode a till scans: black bars on white, with ten modules of white at each end.
function barcode(card) {
  let x = 10;
  const bars = [...code128(card.number)].map((width, index) => {
    const bar = index % 2 ? '' : `<rect x="${x}" width="${width}" height="1"/>`;
    x += Number(width);
    return bar;
  }).join('');
  return `<svg class="barcode" viewBox="0 0 ${x + 10} 1" preserveAspectRatio="none" role="img"
    aria-label="${L('Barcode van kaart', 'Barcode of card')} ${last4(card)}">${bars}</svg>`;
}

// What the till needs from one card: barcode, number and code, on white.
const ticket = (card) => `
  <section class="ticket">
    ${barcode(card)}
    <dl>
      <dt>${L('Kaartnummer', 'Card number')}</dt>
      <dd class="number">${groupNumber(card.number)}</dd>
      <dt>${L('Beveiligingscode', 'Security code')}</dt>
      <dd class="code">${card.code}</dd>
    </dl>
  </section>`;

const blank = (title, text = '') => `
  <div class="blank">${icon('card')}<strong>${title}</strong>${text}</div>`;

// how a purchase was paid: the gift card part and the rest
const paidWith = (cards, total) => `
  <ul class="group">
    <li class="row"><span class="row-main">${L('Cadeaukaarten', 'Gift cards')}</span>${formatEuro(cards)}</li>
    <li class="row"><span class="row-main">${L('Pin', 'Debit card')}</span>${formatEuro(total - cards)}</li>
  </ul>`;

// ---------- cards, card, archive ----------

// while sharing, every change is on the server a moment after it is saved
const backupNotice = () => (state.needsBackup && !sharing ? `
  <div class="group">
    <p class="row notice">${icon('warn')}<span class="row-main">${L('Er zijn nieuwe gegevens zonder back&#8209;up.', 'There is new data without a backup.')}</span></p>
    <button class="row tint" data-action="export">${L('Back-up maken', 'Make a backup')}</button>
  </div>` : '');

// The root of the Betalen tab: every card with money on it. The tab itself starts a payment.
function cardsScreen() {
  const active = sortCards(state.cards.filter((card) => balance(card) > 0));
  const spent = state.cards.length - active.length;
  const month = periodStart('month', new Date());
  const thisMonthPaid = summarize(state.purchases, month, shiftPeriod('month', month, 1)).cards;
  // the first card is the one to use next, so it alone gets the blue pass
  const passes = active.map((card, index) => `
    <li><a class="pass${index ? '' : ' next'}" href="#/kaart/${card.id}">
      <span>${last4(card)}</span>
      <strong>${formatEuro(balance(card))}</strong>
      ${expiryHtml(card)}
    </a></li>`).join('');
  return {
    html: `
      <header class="large-title">
        <h1>${L('Kaarten', 'Cards')}</h1>
        <button class="round plain" data-action="add" aria-label="${L('Kaart toevoegen', 'Add card')}">${icon('plus')}</button>
      </header>
      <section class="summary">
        <p class="footnote">${L('Totaal saldo', 'Total balance')}</p>
        <p class="total">${formatEuro(cardTotal())}</p>
        <p class="footnote">${L(plural(active.length, 'kaart', 'kaarten'), plural(active.length, 'card', 'cards'))}</p>
      </section>
      ${backupNotice()}
      <h2 class="section">${L('Kaarten', 'Cards')}</h2>
      ${active.length
        ? `<ul class="passes">${passes}</ul>`
        : blank(L('Nog geen kaarten', 'No cards yet'), L('Voeg je eerste AH cadeaukaart toe met de plus.', 'Add your first AH gift card with the plus.'))}
      <div class="group">
        <a class="row" href="#/uitgaven">
          <span class="row-main">${L('Bij de kassa <small>Met kaarten betaald deze maand</small>', 'At the till <small>Paid with cards this month</small>')}</span> ${formatEuro(thisMonthPaid)}${icon('next')}</a>
        ${spent ? `<a class="row" href="#/archief"><span class="row-main">${L('Lege kaarten', 'Empty cards')}</span> ${spent}${icon('next')}</a>` : ''}
        ${savedRow('', '9999')}
      </div>`,
  };
}

// ---------- charts ----------

// One column of a chart, `height` of 92 units tall: rounded at the top, square on the baseline; too short to round below 8
const columnShape = (x, width, height, name = '') => (height >= 8
  ? `<path class="${name}" d="M${x} 92V${96 - height}a4 4 0 0 1 4-4h${width - 8}a4 4 0 0 1 4 4V92z"/>`
  : `<rect class="${name}" x="${x}" y="${92 - height}" width="${width}" height="${height}"/>`);
const columnHeight = (total, most) => (most > 0 && total > 0 ? Math.max(Math.round(total / most * 88), 2) : 0);

// Columns for a run of periods: the chosen one in blue, the others grey. A tap on a column chooses it.
// periods: [{ id, name, short, total, chosen }]
function columnChart(periods, action) {
  const most = Math.max(0, ...periods.map((period) => period.total));
  return `<ul class="columns">${periods.map(({ id, name, short, total, chosen }) => {
    const label = `${name}: ${formatEuro(total)}`;
    return `
      <li><button class="column" data-action="${action}" data-id="${id}" aria-pressed="${chosen}" aria-label="${label}" title="${label}">
        <svg viewBox="0 0 24 92" aria-hidden="true">${columnShape(0, 24, columnHeight(total, most))}</svg>
        <span>${short}</span>
      </button></li>`;
  }).join('')}</ul>`;
}

// Two columns per month, money in beside money out, on one scale. The chosen month stands out; a tap chooses another.
function flowChart(months, chosen) {
  const sums = months.map((month) => ({ month, ...monthFigures(month) }));
  const most = Math.max(0, ...sums.flatMap((sum) => [sum.income, sum.spending]));
  return `
    <ul class="columns flow">${sums.map(({ month, income, spending }) => {
      const label = `${monthName(month)}: ${L('in', 'in')} ${formatEuro(income)}, ${L('uit', 'out')} ${formatEuro(spending)}`;
      return `
        <li><button class="column" data-action="pickMonth" data-id="${month}" aria-pressed="${month === chosen}" aria-label="${label}" title="${label}">
          <svg viewBox="0 0 24 92" preserveAspectRatio="none" aria-hidden="true">
            ${columnShape(0, 11, columnHeight(income, most), 'in')}${columnShape(13, 11, columnHeight(spending, most), 'out')}</svg>
          <span>${monthShort(month)}</span>
        </button></li>`;
    }).join('')}</ul>
    <p class="legend"><span><i class="key in"></i>${L('In', 'In')}</span><span><i class="key out"></i>${L('Uit', 'Out')}</span></p>`;
}

// A line through one amount per month. points: [{ id, name, cents }]; a tap on a month chooses it.
function lineChart(points, chosen, action) {
  const low = Math.min(...points.map((point) => point.cents));
  const high = Math.max(...points.map((point) => point.cents));
  const step = points.length > 1 ? 284 / (points.length - 1) : 0;
  const place = points.map((point, index) => ({
    ...point,
    x: points.length > 1 ? 8 + index * step : 150,
    y: high > low ? 86 - (point.cents - low) / (high - low) * 70 : 51,
  }));
  const path = place.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const dot = place.find((point) => point.id === chosen) ?? place.at(-1);
  return `
    <svg class="line" viewBox="0 0 300 100" role="group" aria-label="${L('Verloop per maand', 'Course per month')}">
      ${place.length > 1 ? `<polyline class="stroke" points="${path}"/>` : ''}
      <line class="rule" x1="${dot.x.toFixed(1)}" x2="${dot.x.toFixed(1)}" y1="6" y2="96"/>
      <circle class="dot" cx="${dot.x.toFixed(1)}" cy="${dot.y.toFixed(1)}" r="5"/>
      ${place.map((point) => `<rect class="hit" x="${(point.x - (step || 284) / 2).toFixed(1)}" y="0" width="${(step || 284).toFixed(1)}" height="100"
        role="button" tabindex="0" data-action="${action}" data-id="${point.id}" aria-pressed="${point === dot}"
        aria-label="${point.name}: ${formatEuro(point.cents)}"><title>${point.name}: ${formatEuro(point.cents)}</title></rect>`).join('')}
    </svg>
    <p class="axis"><span>${place[0].name} · ${formatEuro(place[0].cents)}</span>
      <span>${place.length > 1 ? `${place.at(-1).name} · ${formatEuro(place.at(-1).cents)}` : ''}</span></p>`;
}

// A bar for a share of something. A pot's bar is blue, red (`over`) once it is overspent, and has a tick (`pace`, 0-1)
// where today is in the month; `rank` draws a grey bar, for lists that only compare amounts.
const meterBar = (share, { over = false, pace = null, rank = false } = {}) => `
  <svg class="meter${over ? ' over' : ''}${rank ? ' rank' : ''}" aria-hidden="true"><rect class="track" width="100%" height="100%" rx="4"/>
    <rect width="${(Math.max(0, Math.min(share, 1)) * 100).toFixed(1)}%" height="100%" rx="4"/>
    ${pace === null ? '' : `<rect class="pace" x="${(pace * 100).toFixed(1)}%" width="2" height="100%"/>`}</svg>`;

// ---------- the bank side: overview ----------

// The row of a transaction; a tap opens the sheet that sorts it. The line under the name leaves out what the
// screen around it already says: the category on a category's own screen, the account when one is chosen.
function txRow(tx, catOf, { category = true, account = true, toFill } = {}) {
  const cat = catOf(tx);
  const others = cat === 'boodschappen' ? (tx.shares ?? []).filter((share) => share.who !== US).map((share) => esc(shown(share.who))) : [];
  const gift = tx.gift ? `${esc(tx.gift.shop)} ${formatEuro(tx.gift.value)}${cat !== 'cadeaukaarten' || !heldShops(bank).has(tx.gift.shop) ? ''
    : ` · ${tx.gift.shop === AH ? L('op de kaart', 'on the card') : L('op het saldo', 'on the balance')}`}`
    : toFill?.has(tx.id) ? `<span class="todo">${L('winkel invullen', 'fill in the shop')}</span>` : '';
  return `
    <li><button class="row tx" data-action="tx" data-id="${esc(tx.id)}">
      <span class="row-main">${esc(tx.name)} <small>${dayShort(tx.date)}${
        category ? ` · <span${cat ? '' : ' class="todo"'}>${catName(cat)}</span>` : ''}${
        others.length ? ` · ${L('ook voor', 'also for')} ${others.join(', ')}` : ''}${gift ? ` · ${gift}` : ''}${
        account ? ` · ${esc(nameOf(accountById(tx.acc)))}` : ''}</small></span>
      <span class="amount${tx.cents > 0 ? ' plus' : ''}">${signed(tx.cents)}</span>
    </button></li>`;
}

// A pot: a category with an amount per month, what was spent of it, and for the running month where today is.
function potRow(cat, spent, month) {
  const running = month === thisMonth();
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  const day = new Date().getDate();
  const left = cat.budget - spent;
  return `
    <li><a class="row meter-row" href="#/categorie/${cat.id}">
      <span class="row-main">${esc(shown(cat.name))} <small class="under">${formatEuro(spent)} ${L('van', 'of')} ${formatEuro(cat.budget)}</small></span>
      <span class="${left < 0 ? 'over-text' : ''}">${left < 0 ? L(`${formatEuro(-left)} erover`, `${formatEuro(-left)} over`) : L(`nog ${formatEuro(left)}`, `${formatEuro(left)} left`)}</span>
      ${meterBar(spent / cat.budget, { over: left < 0, pace: running ? day / days : null })}
    </a></li>`;
}

// ---------- gift cards bought ----------

const giftIds = () => new Set(giftsToFill(bank).map((tx) => tx.id));
const giftSum = (shops) => shops.reduce((sum, shop) => ({ value: sum.value + shop.value, paid: sum.paid + shop.paid }), { value: 0, paid: 0 });
const giftText = ({ value, paid }) => L(`${formatEuro(value)} aan kaarten voor ${formatEuro(paid)}`, `${formatEuro(value)} of cards for ${formatEuro(paid)}`);
const sinceText = () => (bank.since ? `${L('Sinds', 'Since')} ${monthName(monthOf(bank.since))}` : L('Alles bij elkaar', 'All together'));

// the way to the gift card payments that do not say yet what they bought
function fillRow() {
  const count = giftsToFill(bank).length;
  return count ? `
    <button class="row" data-action="fillGifts"><span class="row-main">${L('Cadeaukaarten invullen', 'Fill in gift cards')}
      <small>${L('Winkel en waarde', 'Shop and value')}</small></span>
      <span class="amount">${L(plural(count, 'aankoop', 'aankopen'), plural(count, 'purchase', 'purchases'))}</span>${icon('next')}</button>` : '';
}

// what the gift cards bought from `from` up to `to` saved, as a row that leads to the gift card category
function savedRow(from, to) {
  const sum = giftSum(giftsBought(bank, from, to));
  return sum.value ? `
    <a class="row" href="#/categorie/cadeaukaarten"><span class="row-main">${L('Bespaard met cadeaukaarten', 'Saved with gift cards')} <small>${giftText(sum)}</small></span>
      <span class="amount">${formatEuro(sum.value - sum.paid)}</span>${icon('next')}</a>` : '';
}

// What the gift card category shows on top of a category's own figures: what the cards saved, in the month on
// screen and in all that is counted, and every shop cards were bought for. The AH row leads to the cards themselves.
function giftSections(from, to) {
  const all = giftsBought(bank, '', '9999');
  if (!all.length) return '';
  const whole = giftSum(all).value;
  const saved = (label, sum) => `
    <li class="row"><span class="row-main">${label} <small>${giftText(sum)}</small></span><span class="amount">${formatEuro(sum.value - sum.paid)}</span></li>`;
  const shopRow = (shop) => {
    const percent = ((shop.value - shop.paid) / shop.value * 100).toLocaleString(LOCALE, { maximumFractionDigits: 1 });
    const saved = `${formatEuro(shop.value - shop.paid)} ${L('bespaard', 'saved')}`;
    const account = balanceOf(shop.shop);
    const left = shop.shop === AH ? `${L('nu', 'now')} ${formatEuro(cardTotal())} ${L('op de kaarten', 'on the cards')}`
      : account ? `${L('nu', 'now')} ${formatEuro(balanceOn(bank, account))} ${L('saldo', 'balance')}` : '';
    const inside = `
      <span class="row-main">${esc(shop.shop)} <small class="under">${left ? `${left} · ${saved}` : `${saved} · ${percent}%`}</small></span>
      <span>${formatEuro(shop.value)}</span>${meterBar(shop.value / whole, { rank: true })}`;
    return shop.shop === AH ? `<li><a class="row meter-row" href="#/kaarten">${inside}</a></li>`
      : account ? `<li><a class="row meter-row" href="#/saldo/${account.id}">${inside}</a></li>`
      : `<li><button class="row meter-row" data-action="startBalance" data-id="${esc(shop.shop)}">${inside}</button></li>`;
  };
  return `
    <h2 class="section">${L('Bespaard', 'Saved')}</h2>
    <ul class="group">
      ${saved(`${L('In', 'In')} ${monthName(view.month)}`, giftSum(giftsBought(bank, from, to)))}
      ${saved(sinceText(), giftSum(all))}
    </ul>
    <h2 class="section">${L('Gekocht per winkel', 'Bought per shop')} · ${sinceText()}</h2>
    <ul class="group">${all.map(shopRow).join('')}</ul>
    <p class="group-note">${L('Heb je bij een winkel nog saldo staan? Tik op de winkel om het bij te houden. Een kaart voor die winkel is dan saldo, en wat je eruit betaalt is de uitgave.',
      'Do you still have a balance at a shop? Tap the shop to keep it. A card for that shop is then balance, and what you pay from it is the spending.')}</p>`;
}

// A shop's balance: what is left, what it pays every month, and everything that moved it. A gift card bought
// for the shop adds what the card is worth; a tap on a line opens the transaction behind it.
function balanceScreen(account) {
  if (!account?.shop) return overviewScreen();
  const catOf = sorter(bank);
  const moves = [
    ...bank.txs.filter((tx) => tx.acc === account.id).map((tx) => ({
      tx, cents: tx.cents, name: esc(tx.name), detail: `<span${catOf(tx) ? '' : ' class="todo"'}>${catName(catOf(tx))}</span>` })),
    ...bank.txs.filter((tx) => tx.gift?.shop === account.shop).map((tx) => ({
      tx, cents: tx.gift.value, name: L('Cadeaukaart', 'Gift card'), detail: `${formatEuro(-tx.cents)} ${L('betaald', 'paid')}` })),
  ].sort((a, b) => b.tx.date.localeCompare(a.tx.date));
  return {
    html: `
      <header class="navbar">${backButton()}<h1>${esc(nameOf(account))}</h1><span></span></header>
      <section class="summary">
        <p class="footnote">${L('Saldo nu', 'Balance now')}</p>
        <p class="total">${formatEuro(balanceOn(bank, account))}</p>
        <p class="footnote">${L('Ingevuld op', 'Entered on')} ${dayShort(account.through)}</p>
      </section>
      <div class="group">
        <button class="row tint" data-action="addPayment" data-id="${account.id}">${L('Betaling toevoegen', 'Add a payment')}</button>
        <button class="row tint" data-action="correctBalance" data-id="${account.id}">${L('Saldo corrigeren', 'Correct balance')}</button>
      </div>
      ${account.monthly.length ? `
        <h2 class="section">${L('Elke maand', 'Every month')}</h2>
        <ul class="group">${account.monthly.map((each, index) => `
          <li class="row"><span class="row-main">${esc(each.name)} <small>${formatEuro(-each.cents)} · ${L('weer op', 'next on')} ${dayShort(dueOn(each))}</small></span>
            <button class="text-button" data-action="stopMonthly" data-id="${account.id}" data-index="${index}">${L('Stoppen', 'Stop')}</button></li>`).join('')}</ul>` : ''}
      <h2 class="section">${L('Geschiedenis', 'History')}</h2>
      ${moves.length ? `<ul class="group">${moves.slice(0, view.rows).map((move) => `
        <li><button class="row tx" data-action="tx" data-id="${esc(move.tx.id)}">
          <span class="row-main">${move.name} <small>${dayShort(move.tx.date)} · ${move.detail}</small></span>
          <span class="amount${move.cents > 0 ? ' plus' : ''}">${signed(move.cents)}</span>
        </button></li>`).join('')}</ul>
        ${moves.length > view.rows ? `<div class="group"><button class="row tint" data-action="moreRows">${L('Toon meer', 'Show more')}</button></div>` : ''}` : ''}
      <p class="group-note">${L(`Het saldo is ingevuld op ${dayShort(account.through)}. Betalingen en cadeaukaarten van daarna gaan eraf of komen erbij; wat eerder was, zat er al in.`,
        `The balance was entered on ${dayShort(account.through)}. Payments and gift cards after that day lower or raise it; what came earlier was in it already.`)}</p>
      <div class="group">
        <button class="row danger" data-action="removeBalance" data-id="${account.id}">${L('Saldo niet meer bijhouden', 'Stop keeping this balance')}</button>
      </div>`,
  };
}

const pots = () => bank.cats.filter((cat) => cat.kind === 'out' && cat.budget);
const openCount = () => inCategory(bank, '', '', '9999').length;

// "9 van 12 betaald", for the fixed costs of a month
function fixedSummary(month) {
  const costs = fixedCosts(bank, month);
  const paid = costs.filter((cost) => cost.paid).length;
  return { costs, text: L(`${paid} van ${costs.length} betaald`, `${paid} of ${costs.length} paid`), total: costs.reduce((sum, cost) => sum + cost.paid, 0) };
}

function accountRows(date) {
  return bank.accounts.map((account) => (account.shop ? `
    <li><a class="row" href="#/saldo/${account.id}">
      <span class="row-main">${esc(nameOf(account))} <small>${L('Saldo bij de winkel', 'Balance at the shop')}</small></span>
      <span class="amount">${formatEuro(balanceOn(bank, account, date))}</span>${icon('next')}</a></li>` : `
    <li><button class="row" data-action="renameAccount" data-id="${esc(account.id)}">
      <span class="row-main">${esc(account.name)} <small>${L('t/m', 'up to')} ${dayShort(account.through)} · ${L('geüpload', 'uploaded')} ${dayShort(isoDate(new Date(account.uploaded)))}</small></span>
      <span class="amount">${formatEuro(balanceOn(bank, account, date))}</span>
    </button></li>`)).join('');
}

const worthOn = (date) => bank.accounts.reduce((sum, account) => sum + balanceOn(bank, account, date), 0) + cardsOn(state.cards, date);

const uploadRow = () => `<button class="row tint" data-action="upload">${icon('upload')}<span class="row-main">${L('Bankbestanden uploaden', 'Upload bank files')}</span></button>`;

function overviewScreen() {
  const month = thisMonth();
  const now = monthFigures(month);
  const today = isoDate();
  const oldest = Math.max(0, ...bank.accounts.filter((account) => !account.shop).map((account) => daysLeft(today, isoDate(new Date(account.uploaded)))));
  const fixed = fixedSummary(month);
  const suggested = fixedSuggestions(bank, month).length;
  const open = openCount();
  const gaps = bank.accounts.filter((account) => hasGap(bank, account));
  const title = `
    <header class="large-title">
      <h1>Kassa</h1>
      <a class="round plain" href="#/meer" aria-label="${L('Instellingen', 'Settings')}">${icon('gear')}</a>
    </header>`;
  const cards = `
    <a class="row" href="#/kaarten"><span class="row-main">${L('Cadeaukaarten', 'Gift cards')}</span>
      <span class="amount">${formatEuro(cardTotal())}</span>${icon('next')}</a>`;
  if (!bank.accounts.length) {
    return {
      html: `${title}
        ${backupNotice()}
        ${blank(L('Nog geen bankgegevens', 'No bank data yet'), L('Upload het CSV-bestand van je Rabo-rekening of creditcard, of het PDF-afschrift van Openbank.',
          'Upload the CSV file of your Rabo account or credit card, or the PDF statement from Openbank.'))}
        <div class="group">${uploadRow()}</div>
        <div class="group">${cards}</div>`,
    };
  }
  return {
    html: `${title}
      <a class="summary" href="#/inzicht">
        <p class="footnote">${L('Uitgegeven in', 'Spent in')} ${monthName(month)}</p>
        <p class="total">${formatEuro(now.spending)}</p>
        <p class="footnote">${L('Binnengekomen', 'Came in')} ${formatEuro(now.income)} · ${now.income >= now.spending
          ? `<span class="amount">${L('over', 'left')} ${formatEuro(now.income - now.spending)}</span>`
          : `<span class="amount">${L('tekort', 'short')} ${formatEuro(now.spending - now.income)}</span>`}</p>
      </a>
      ${oldest > STALE ? `
        <div class="group">
          <p class="row notice">${icon('warn')}<span class="row-main">${L(`De laatste upload is ${oldest} dagen oud. Tijd voor nieuwe bestanden.`,
            `The last upload is ${oldest} days old. Time for new files.`)}</span></p>
          ${uploadRow()}
        </div>` : ''}
      ${gaps.length ? `
        <div class="group"><p class="row notice">${icon('warn')}<span class="row-main">${L('Er ontbreken transacties bij', 'Transactions are missing for')}
          ${gaps.map((account) => esc(account.name)).join(', ')}. ${L('Upload ook de periode ertussen.', 'Upload the period in between as well.')}</span></p></div>` : ''}
      ${backupNotice()}
      <h2 class="section">${L('Potjes', 'Pots')}</h2>
      <ul class="group">
        ${pots().map((cat) => potRow(cat, now.byCat.get(cat.id) ?? 0, month)).join('')
          || `<li><a class="row tint" href="#/potjes">${L('Kies een bedrag per maand voor een potje', 'Choose an amount per month for a pot')}</a></li>`}
      </ul>
      <div class="group">
        ${open ? `<a class="row" href="#/categorie/open"><span class="row-main">${L('Nog indelen', 'To sort')}</span>
          <span class="amount">${L(plural(open, 'transactie', 'transacties'), plural(open, 'transaction', 'transactions'))}</span>${icon('next')}</a>` : ''}
        ${fillRow()}
        <a class="row" href="#/vast"><span class="row-main">${L('Vaste lasten', 'Fixed costs')}
          <small>${fixed.costs.length ? fixed.text : suggested ? L(plural(suggested, 'voorstel', 'voorstellen'), plural(suggested, 'suggestion', 'suggestions')) : L('Nog geen', 'None yet')}</small></span>
          <span class="amount">${fixed.costs.length ? formatEuro(fixed.total) : ''}</span>${icon('next')}</a>
      </div>
      <h2 class="section">${L('Rekeningen', 'Accounts')}</h2>
      <ul class="group">
        ${accountRows()}
        <li>${cards}</li>
        <li class="row"><strong class="row-main">${L('Samen', 'Together')}</strong><strong class="amount">${formatEuro(worthOn('9999'))}</strong></li>
      </ul>
      <div class="group">${uploadRow()}</div>`,
  };
}

// ---------- pots, a category, fixed costs ----------

// previous and next month (or year) around the name of the one on screen
function stepper(name, atEnd) {
  return `
    <div class="stepper">
      <button data-action="monthStep" data-by="-1" aria-label="${L('Vorige', 'Previous')}">${icon('back')}</button>
      <h2>${name}</h2>
      <button data-action="monthStep" data-by="1" aria-label="${L('Volgende', 'Next')}"${atEnd ? ' disabled' : ''}>${icon('next')}</button>
    </div>`;
}
const monthStepper = () => stepper(monthName(view.month), view.month >= thisMonth());

function potsScreen() {
  const now = monthFigures(view.month);
  const spending = bank.cats.filter((cat) => cat.kind === 'out');
  const others = spending.filter((cat) => !cat.budget).map((cat) => [cat, now.byCat.get(cat.id) ?? 0]).sort((a, b) => b[1] - a[1]);
  const open = now.byCat.get('') ?? 0;
  const fixed = fixedSummary(view.month);
  return {
    html: `
      <header class="large-title"><h1>${L('Potjes', 'Pots')}</h1></header>
      <section class="summary period">
        ${monthStepper()}
        <p class="total">${formatEuro(now.spending)}</p>
        <p class="footnote center">${L('uitgegeven', 'spent')}</p>
      </section>
      <h2 class="section">${L('Potjes', 'Pots')}</h2>
      ${pots().length ? `<ul class="group">${pots().map((cat) => potRow(cat, now.byCat.get(cat.id) ?? 0, view.month)).join('')}</ul>`
        : `<p class="group-note">${L('Een potje is een categorie met een bedrag per maand. Tik hieronder op een categorie en kies Bewerken om er een bedrag aan te geven.',
          'A pot is a category with an amount per month. Tap a category below and choose Edit to give it one.')}</p>`}
      <h2 class="section">${L('Zonder maandbedrag', 'Without a monthly amount')}</h2>
      <ul class="group">
        ${others.map(([cat, cents]) => `
          <li><a class="row" href="#/categorie/${cat.id}"><span class="row-main">${esc(shown(cat.name))}</span>
            <span class="amount">${formatEuro(cents)}</span>${icon('next')}</a></li>`).join('')}
        ${open ? `<li><a class="row" href="#/categorie/open"><span class="row-main todo">${L('Nog indelen', 'To sort')}</span>
          <span class="amount">${formatEuro(open)}</span>${icon('next')}</a></li>` : ''}
      </ul>
      <div class="group">
        <a class="row" href="#/vast"><span class="row-main">${L('Vaste lasten', 'Fixed costs')} <small>${fixed.costs.length ? fixed.text : L('Nog geen', 'None yet')}</small></span>
          <span class="amount">${fixed.costs.length ? formatEuro(fixed.total) : ''}</span>${icon('next')}</a>
      </div>`,
  };
}

// A category and the fixed costs are reached from several tabs: back names the one the owner came from.
const backButton = () => `<button class="back" data-action="back">${icon('back')}${TABS.find(([id]) => id === tab)[3]}</button>`;

// One category in one month: what it cost, the months before, who was paid, and every transaction.
// The id 'open' stands for everything that still has to be sorted, of all months together.
function categoryScreen(id) {
  const cat = catById(id);
  if (!cat && id !== 'open') return potsScreen();
  const [from, to] = cat ? monthRange(view.month) : ['', '9999'];
  const txs = inCategory(bank, cat?.id ?? '', from, to);
  const catOf = sorter(bank);
  const sign = cat?.kind === 'in' ? 1 : -1; // spending is shown as a positive amount
  // Who the groceries were for, once any of them was for someone else. Under "Voor anderen" the others alone,
  // and one row for all that came out of the groceries, by card or by pin.
  const forOthers = cat?.id === 'anderen';
  const everyone = cat?.id === 'boodschappen' || forOthers ? forWhom(bank, state.purchases, from, to) : [];
  const who = forOthers ? everyone.filter(([name]) => name !== US) : everyone.some(([name]) => name !== US) ? everyone : [];
  const whoTotal = Math.max(1, who.reduce((sum, [, cents]) => sum + Math.max(0, cents), 0));
  const fromCards = !cat ? 0 : forOthers ? who.reduce((sum, [, cents]) => sum + cents, 0)
    : figures({ ...bank, txs: [] }, state.purchases, from, to).byCat.get(cat.id) ?? 0;
  const total = cat?.kind === 'none' ? txs.reduce((sum, tx) => sum + tx.cents, 0) : (monthFigures(view.month).byCat.get(cat?.id ?? '') ?? 0);
  const parties = byParty(txs);
  // the size of a bar: what was spent (or, for income, received); money the other way gets none. Unsorted money counts either way.
  const size = (party) => (cat && cat.kind !== 'none' ? Math.max(0, sign * party.cents) : Math.abs(party.cents));
  const whole = Math.max(1, fromCards + parties.reduce((sum, party) => sum + size(party), 0)); // the bars are shares of this
  const months = Array.from({ length: 6 }, (unused, index) => shiftMonth(view.month >= shiftMonth(thisMonth(), -5) ? thisMonth() : view.month, index - 5));
  const shownRows = txs.slice(0, view.rows);
  const gifts = cat?.id === 'cadeaukaarten'; // everything here was paid to the shop that sells the cards: the shops the cards are for say more
  const toFill = giftIds();
  return {
    html: `
      <header class="navbar">
        ${backButton()}
        <h1>${catName(cat?.id)}</h1>
        ${cat ? `<button class="text-button" data-action="editCat" data-id="${cat.id}">${L('Bewerken', 'Edit')}</button>` : '<span></span>'}
      </header>
      ${cat ? `
        <section class="summary period">
          ${monthStepper()}
          <p class="total">${cat.kind === 'none' ? signed(total) : formatEuro(total)}</p>
          ${cat.budget ? `<ul class="plain">${potRow(cat, total, view.month).replace('<a class="row meter-row" href', '<a class="row meter-row bare" href')}</ul>` : ''}
          ${cat.kind === 'none' ? '' : columnChart(months.map((month) => ({
            id: month, name: monthName(month), short: monthShort(month), total: Math.max(0, monthFigures(month).byCat.get(cat.id) ?? 0), chosen: month === view.month,
          })), 'pickMonth')}
        </section>`
      : `<p class="group-note">${L('Tik op een naam en kies een categorie. Alles van die naam gaat dan mee, ook wat later binnenkomt.',
        'Tap a name and choose a category. Everything from that name follows, including what comes in later.')}</p>`}
      ${who.length ? `
        <h2 class="section">${L('Voor wie', 'For whom')}</h2>
        <ul class="group">${who.map(([name, cents]) => `
          <li class="row meter-row"><span class="row-main">${esc(shown(name))}</span>
            <span>${formatEuro(cents)}</span>${meterBar(Math.max(0, cents) / whoTotal, { rank: true })}</li>`).join('')}</ul>` : ''}
      ${gifts ? `${fillRow() && `<div class="group">${fillRow()}</div>`}${giftSections(from, to)}` : ''}
      ${parties.length || fromCards ? `
        ${gifts ? '' : `
        <h2 class="section">${cat ? L('Bij wie', 'Where') : L('Per naam, grootste eerst', 'Per name, largest first')}</h2>
        <ul class="group">
          ${fromCards ? `<li><a class="row meter-row" href="${forOthers ? '#/categorie/boodschappen' : '#/uitgaven'}">
            <span class="row-main">${forOthers ? L('Uit de boodschappen', 'From the groceries') : L('AH met cadeaukaarten', 'AH with gift cards')}</span>
            <span>${formatEuro(fromCards)}</span>${meterBar(fromCards / whole, { rank: true })}</a></li>` : ''}
          ${parties.slice(0, view.rows).map((party) => `
            <li><button class="row meter-row" data-action="sortParty" data-id="${esc(txs.find((tx) => ruleKey(tx.name) === party.key).id)}">
              <span class="row-main">${esc(party.name)}${party.count > 1 ? ` <small class="inline">${party.count}×</small>` : ''}</span>
              <span class="${cat ? '' : party.cents > 0 ? 'plus' : ''}">${cat && cat.kind !== 'none' ? formatEuro(sign * party.cents) : signed(party.cents)}</span>
              ${meterBar(size(party) / whole, { rank: true })}
            </button></li>`).join('')}
        </ul>`}
        <h2 class="section">${L('Transacties', 'Transactions')}</h2>
        <ul class="group">${shownRows.map((tx) => txRow(tx, catOf, { category: false, toFill })).join('')}</ul>
        ${txs.length > shownRows.length ? `<div class="group"><button class="row tint" data-action="moreRows">${L('Toon meer', 'Show more')}</button></div>` : ''}
        ${cat?.id === 'boodschappen' ? `<p class="group-note">${L('Was iets, of een deel ervan, voor iemand anders? Tik op de transactie en kies Voor wie.',
          'Was something, or part of it, for someone else? Tap the transaction and choose For whom.')}</p>` : ''}
        ${gifts ? `<p class="group-note">${L(`Een kaart van ${AH}, of van een winkel waarvan je het saldo bijhoudt, telt hier niet mee: het geld telt als uitgave zodra je ermee betaalt.`,
          `A card for ${AH}, or for a shop whose balance you keep, does not count here: the money counts as spending once you pay with it.`)}</p>` : ''}`
      : blank(cat ? L('Niets in deze maand', 'Nothing this month') : L('Alles is ingedeeld', 'Everything is sorted'))}`,
  };
}

function fixedScreen() {
  const { costs, total } = fixedSummary(view.month);
  const waiting = costs.filter((cost) => !cost.paid).reduce((sum, cost) => sum + cost.expected, 0);
  const catOf = sorter(bank);
  const latest = (key) => bank.txs.filter((tx) => ruleKey(tx.name) === key).sort((a, b) => b.date.localeCompare(a.date))[0];
  const suggestions = fixedSuggestions(bank, thisMonth());
  const status = (cost) => (!cost.paid ? L('Nog niet betaald', 'Not paid yet')
    : cost.expected && cost.paid !== cost.expected ? L(`Betaald · de keer ervoor ${formatEuro(cost.expected)}`, `Paid · last time ${formatEuro(cost.expected)}`)
    : L('Betaald', 'Paid'));
  return {
    html: `
      <header class="navbar">${backButton()}<h1>${L('Vaste lasten', 'Fixed costs')}</h1><span></span></header>
      <section class="summary period">
        ${monthStepper()}
        <p class="total">${formatEuro(total)}</p>
        <p class="footnote center">${L('betaald', 'paid')}${waiting ? ` · ${L('nog verwacht', 'still expected')} ${formatEuro(waiting)}` : ''}</p>
      </section>
      ${costs.length ? `
        <ul class="group">${costs.map((cost) => `
          <li><button class="row" data-action="tx" data-id="${esc(latest(cost.key).id)}">
            <span class="row-main">${esc(cost.name)} <small>${status(cost)} · ${catName(catOf(latest(cost.key)))}</small></span>
            <span class="amount${cost.paid ? '' : ' quiet'}">${formatEuro(cost.paid || cost.expected)}</span>
          </button></li>`).join('')}</ul>`
      : `<p class="group-note">${L('Een vaste last is iets dat je elke maand betaalt. Kies hieronder Ja bij een voorstel, of zet bij een transactie de schakelaar Vaste last aan.',
        'A fixed cost is something you pay every month. Choose Yes for a suggestion below, or switch on Fixed cost on a transaction.')}</p>`}
      ${suggestions.length ? `
        <h2 class="section">${L('Voorstellen', 'Suggestions')}</h2>
        <ul class="group">${suggestions.map((each) => `
          <li class="row">
            <span class="row-main">${esc(each.name)} <small>${formatEuro(each.cents)} ${L('per maand', 'a month')}</small></span>
            <button class="text-button" data-action="fixedNo" data-id="${esc(each.key)}">${L('Nee', 'No')}</button>
            <button class="text-button strong" data-action="fixedYes" data-id="${esc(each.key)}">${L('Ja', 'Yes')}</button>
          </li>`).join('')}</ul>
        <p class="group-note">${L('Deze namen zijn de laatste drie maanden elke maand één keer betaald.', 'These names were paid once in each of the last three months.')}</p>` : ''}`,
  };
}

// ---------- insight ----------

const yearOf = (month) => month.slice(0, 4);
// the months a chart shows: the twelve up to now (or up to the chosen month when that is older), or the chosen year
function chartMonths() {
  const first = bank.since ? monthOf(bank.since) : '';
  const end = view.month >= shiftMonth(thisMonth(), -11) ? thisMonth() : view.month;
  const all = view.unit === 'year'
    ? Array.from({ length: 12 }, (unused, index) => `${yearOf(view.month)}-${String(index + 1).padStart(2, '0')}`)
    : Array.from({ length: 12 }, (unused, index) => shiftMonth(end, index - 11));
  return all.filter((month) => month >= first && month <= thisMonth());
}

function insightScreen() {
  const yearly = view.unit === 'year';
  const year = yearOf(view.month);
  const [from, to] = yearly ? [`${year}-01-01`, `${Number(year) + 1}-01-01`] : monthRange(view.month);
  const now = figures(bank, state.purchases, from, to);
  const left = now.income - now.spending;
  const short = left < 0 && to <= isoDate(); // only a period that is over can end short
  const kinds = new Map(bank.cats.map((cat) => [cat.id, cat.kind]));
  const spent = [...now.byCat].filter(([id, cents]) => (kinds.get(id) ?? (cents > 0 ? 'out' : '')) === 'out' && cents > 0).sort((a, b) => b[1] - a[1]);
  const earned = [...now.byCat].filter(([id]) => kinds.get(id) === 'in').sort((a, b) => b[1] - a[1]);
  const before = [1, 2, 3].map((back) => monthFigures(shiftMonth(view.month, -back)).spending);
  // From what was left to what the net worth did. Money that only moved is not spending, but a loan repaid or
  // money sent to an account the app does not hold did leave the accounts; the rest is the gift cards (a card
  // is worth more than it cost, and balance can be added or corrected by hand).
  const dayBefore = (date) => new Date(Date.parse(date) - 864e5).toISOString().slice(0, 10);
  const worthWas = worthOn(dayBefore(from > bank.since ? from : bank.since));
  const worthIs = worthOn(dayBefore(to));
  const moves = bank.cats.filter((cat) => cat.kind === 'none').map((cat) => [cat, now.moved.get(cat.id) ?? 0]).filter(([, cents]) => cents);
  const cardGain = worthIs - worthWas - left - moves.reduce((sum, [, cents]) => sum + cents, 0);
  const versus = (label, detail, other) => (other ? `
    <li class="row"><span class="row-main">${label} <small>${detail}</small></span>
      <span class="amount">${formatEuro(Math.abs(now.spending - other))} ${now.spending > other ? L('meer', 'more') : L('minder', 'less')}</span></li>` : '');
  // net worth at the end of each month; the running month stands at today
  const points = chartMonths().map((month) => ({ id: month, name: monthShort(month), cents: worthOn(month === thisMonth() ? '9999' : `${month}-31`) }));
  const worthMonth = points.some((point) => point.id === view.worth) ? view.worth : points.at(-1)?.id;
  const fixed = fixedSummary(view.month);
  if (!bank.accounts.length) {
    return { html: `<header class="large-title"><h1>${L('Inzicht', 'Insight')}</h1></header>
      ${blank(L('Nog niets te zien', 'Nothing to see yet'), L('Upload eerst je bankbestanden op Overzicht.', 'Upload your bank files on Overview first.'))}` };
  }
  return {
    html: `
      <header class="large-title"><h1>${L('Inzicht', 'Insight')}</h1></header>
      <div class="segments" role="group" aria-label="${L('Periode', 'Period')}">
        <button data-action="unit" data-id="month" aria-pressed="${!yearly}">${L('Maand', 'Month')}</button>
        <button data-action="unit" data-id="year" aria-pressed="${yearly}">${L('Jaar', 'Year')}</button>
      </div>
      <section class="summary period">
        ${yearly ? stepper(year, year >= yearOf(thisMonth())) : monthStepper()}
        <dl class="trio">
          <div><dt>${L('In', 'In')}</dt><dd>${formatEuro(now.income)}</dd></div>
          <div><dt>${L('Uit', 'Out')}</dt><dd>${formatEuro(now.spending)}</dd></div>
          <div><dt>${left < 0 ? L('Tekort', 'Short') : L('Over', 'Left')}</dt><dd class="${short ? 'over-text' : ''}">${formatEuro(Math.abs(left))}</dd></div>
        </dl>
        ${now.income > 0 && left > 0 ? `<p class="footnote center">${Math.round(left / now.income * 100)}% ${L('van wat binnenkwam bleef over', 'of what came in was left')}</p>` : ''}
        ${flowChart(chartMonths(), yearly ? '' : view.month)}
      </section>
      ${yearly ? '' : `<ul class="group">
        ${versus(L('Uit, tegen de maand ervoor', 'Out, against the month before'), monthName(shiftMonth(view.month, -1)), before[0])}
        ${versus(L('Uit, tegen het gemiddelde', 'Out, against the average'), L('van de drie maanden ervoor', 'of the three months before'), before.every(Boolean) ? average(before) : 0)}
      </ul>`}
      ${moves.length || cardGain ? `
        <h2 class="section">${L('Over en vermogen', 'Left over and net worth')}</h2>
        <ul class="group">
          <li class="row"><span class="row-main">${left < 0 ? L('Tekort', 'Short') : L('Over', 'Left')}</span><span class="amount">${signed(left)}</span></li>
          ${moves.map(([cat, cents]) => `
            <li><a class="row" href="#/categorie/${cat.id}"><span class="row-main">${esc(shown(cat.name))}${cat.id === 'overboeking'
              ? ` <small>${L('van of naar een rekening buiten de app', 'from or to an account outside the app')}</small>` : ''}</span>
              <span class="amount">${signed(cents)}</span>${icon('next')}</a></li>`).join('')}
          ${cardGain ? `<li class="row"><span class="row-main">${L('Cadeaukaarten', 'Gift cards')} <small>${L('korting en correcties van het saldo', 'discount and corrections of the balance')}</small></span>
            <span class="amount">${signed(cardGain)}</span></li>` : ''}
          <li class="row"><span class="row-main"><strong>${L('Vermogen', 'Net worth')}</strong>
            <small>${L('van', 'from')} ${formatEuro(worthWas)} ${L('naar', 'to')} ${formatEuro(worthIs)}</small></span>
            <strong class="amount">${signed(worthIs - worthWas)}</strong></li>
        </ul>
        <p class="group-note">${L('Geld dat je aflost of wegzet telt niet als uitgave, maar gaat wel van je rekeningen af. Daarom groeit je vermogen niet altijd met wat over is.',
          'Money you repay or set aside does not count as spending, but it does leave your accounts. That is why your net worth does not always grow by what is left.')}</p>` : ''}
      ${spent.length ? `
        <h2 class="section">${L('Uitgaven per categorie', 'Spending per category')}</h2>
        <ul class="group">${spent.map(([id, cents]) => `
          <li><a class="row meter-row" href="#/categorie/${id || 'open'}">
            <span class="row-main${id ? '' : ' todo'}">${catName(id)}</span>
            <span>${formatEuro(cents)} <small class="inline">${Math.round(cents / now.spending * 100)}%</small></span>
            ${meterBar(cents / now.spending, { rank: true })}
          </a></li>`).join('')}</ul>` : ''}
      ${earned.length ? `
        <h2 class="section">${L('Inkomen', 'Income')}</h2>
        <ul class="group">${earned.map(([id, cents]) => `
          <li><a class="row" href="#/categorie/${id}"><span class="row-main">${catName(id)}</span><span class="amount">${formatEuro(cents)}</span>${icon('next')}</a></li>`).join('')}</ul>` : ''}
      ${yearly || !fixed.costs.length ? '' : `
        <div class="group"><a class="row" href="#/vast"><span class="row-main">${L('Vaste lasten', 'Fixed costs')} <small>${fixed.text}</small></span>
          <span class="amount">${formatEuro(fixed.total)}</span>${icon('next')}</a></div>`}
      ${savedRow(from, to) && `<div class="group">${savedRow(from, to)}</div>`}
      ${points.length ? `
        <h2 class="section">${L('Vermogen', 'Net worth')}</h2>
        <section class="summary worth">
          <p class="footnote">${worthMonth === thisMonth() ? L('Nu', 'Now') : `${L('Eind', 'End of')} ${monthName(worthMonth)}`}</p>
          <p class="total small">${formatEuro(points.find((point) => point.id === worthMonth).cents)}</p>
          ${lineChart(points, worthMonth, 'pickWorth')}
        </section>
        <ul class="group">
          ${bank.accounts.map((account) => `<li class="row"><span class="row-main">${esc(nameOf(account))}</span>
            <span class="amount">${formatEuro(balanceOn(bank, account, worthMonth === thisMonth() ? '9999' : `${worthMonth}-31`))}</span></li>`).join('')}
          <li class="row"><span class="row-main">${L('Cadeaukaarten', 'Gift cards')}</span>
            <span class="amount">${formatEuro(cardsOn(state.cards, worthMonth === thisMonth() ? '9999' : `${worthMonth}-31`))}</span></li>
        </ul>` : ''}`,
  };
}

// ---------- transactions ----------

// The list under the search field and the two pick lists, newest first, a heading per month.
function txList() {
  const catOf = sorter(bank);
  const words = view.query.trim().toLowerCase();
  const wanted = view.cat === 'open' ? '' : view.cat;
  const found = bank.txs.filter((tx) => (view.acc === 'all' || tx.acc === view.acc)
    && (view.cat === 'all' || catOf(tx) === wanted)
    && (!words || `${tx.name} ${tx.text} ${euroInput(Math.abs(tx.cents))}`.toLowerCase().includes(words)))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!found.length) return blank(L('Niets gevonden', 'Nothing found'));
  const months = new Map();
  const toFill = giftIds();
  for (const tx of found.slice(0, view.rows)) months.set(monthOf(tx.date), [...(months.get(monthOf(tx.date)) ?? []), tx]);
  return `${[...months].map(([month, txs]) => `
    <h2 class="section">${monthName(month)}</h2>
    <ul class="group">${txs.map((tx) => txRow(tx, catOf, { account: view.acc === 'all', toFill })).join('')}</ul>`).join('')}
    ${found.length > view.rows ? `<div class="group"><button class="row tint" data-action="moreRows">${L('Toon meer', 'Show more')} (${found.length - view.rows})</button></div>` : ''}`;
}

function transactionsScreen() {
  const option = (value, label, chosen) => `<option value="${esc(value)}"${value === chosen ? ' selected' : ''}>${label}</option>`;
  if (!bank.txs.length) {
    return { html: `<header class="large-title"><h1>${L('Transacties', 'Transactions')}</h1></header>
      ${blank(L('Nog geen transacties', 'No transactions yet'), L('Upload eerst je bankbestanden op Overzicht.', 'Upload your bank files on Overview first.'))}` };
  }
  return {
    html: `
      <header class="large-title"><h1>${L('Transacties', 'Transactions')}</h1></header>
      <label class="search">${icon('search')}
        <input id="txSearch" type="search" enterkeyhint="search" autocomplete="off" value="${esc(view.query)}"
          placeholder="${L('Zoek op naam, omschrijving of bedrag', 'Search name, description or amount')}" aria-label="${L('Zoeken', 'Search')}">
      </label>
      <div class="filters">
        <label><select data-filter="cat" aria-label="${L('Categorie', 'Category')}">
          ${option('all', L('Alle categorieën', 'All categories'), view.cat)}${option('open', L('Nog indelen', 'To sort'), view.cat)}
          ${sortedCats().map((cat) => option(cat.id, esc(shown(cat.name)), view.cat)).join('')}</select>${icon('updown')}</label>
        <label><select data-filter="acc" aria-label="${L('Rekening', 'Account')}">
          ${option('all', L('Alle rekeningen', 'All accounts'), view.acc)}
          ${bank.accounts.map((account) => option(account.id, esc(nameOf(account)), view.acc)).join('')}</select>${icon('updown')}</label>
      </div>
      <div id="txList">${txList()}</div>`,
  };
}

// ---------- settings ----------

function shareSection() {
  if (!sharing) {
    return `
      <h2 class="section">${L('Samen delen', 'Sharing')}</h2>
      <div class="group">
        <button class="row tint" data-action="share">${L('Delen met Face ID', 'Share with Face ID')}</button>
        <button class="row tint" data-action="joinShare">${L('Uitnodigingscode invoeren', 'Enter an invite code')}</button>
      </div>
      <p class="group-note">${L('Zie op twee telefoons dezelfde kaarten en bankgegevens. Ze gaan op slot naar de Kassa-server; alleen jullie passkeys (Face ID) maken ze open.',
        'See the same cards and bank data on two phones. They go to the Kassa server locked; only your passkeys (Face ID) open them.')}</p>`;
  }
  const status = syncing ? L('Bijwerken…', 'Updating…')
    : syncError?.status === 401 ? L('Deze telefoon wordt niet meer toegelaten.', 'This phone is no longer let in.')
      : syncError ? L('Nog niet bijgewerkt: geen verbinding met de Kassa-server. Wat je wijzigt, gaat mee zodra die er is.',
        'Not updated yet: no connection with the Kassa server. What you change goes along as soon as there is one.')
        : L('Alles is bijgewerkt.', 'Everything is up to date.');
  return `
    <h2 class="section">${L('Samen delen', 'Sharing')}</h2>
    <div class="group">
      <button class="row tint" data-action="invite">${L('Iemand uitnodigen', 'Invite someone')}</button>
      <button class="row tint" data-action="syncNow">${L('Nu bijwerken', 'Update now')}</button>
    </div>
    <p class="group-note" aria-live="polite">${status} ${L('Zolang Kassa open is, zie je binnen tien seconden wat de ander wijzigt.', 'While Kassa is open, you see what the other phone changes within ten seconds.')}</p>`;
}

function settingsScreen() {
  return {
    html: `
      <header class="navbar">
        <a class="back" href="#/">${icon('back')}${L('Overzicht', 'Overview')}</a>
        <h1>${L('Instellingen', 'Settings')}</h1>
        <span></span>
      </header>
      <h2 class="section">${L('Bankbestanden', 'Bank files')}</h2>
      <div class="group">${uploadRow()}</div>
      <p class="group-note">${L(`Kies één of meer bestanden: het CSV-bestand van een Rabo-rekening of creditcard, of het PDF-afschrift van Openbank.
        Bestanden mogen elkaar overlappen: wat er al staat, komt er niet nog eens bij.`, `Choose one or more files: the CSV file of a Rabo account or
        credit card, or the PDF statement from Openbank. Files may overlap: what is already there is not added again.`)}</p>
      ${bank.accounts.length ? `
        <h2 class="section">${L('Rekeningen', 'Accounts')}</h2>
        <ul class="group">${accountRows()}</ul>
        <p class="group-note">${L('Tik op een rekening om de naam te wijzigen.', 'Tap an account to change its name.')}</p>` : ''}
      <h2 class="section">${L('Rekenen', 'Counting')}</h2>
      <div class="group">
        <label class="row"><span class="row-main">${L('Tellen vanaf', 'Count from')}</span>
          <input id="sinceInput" type="date" value="${bank.since}" aria-label="${L('Tellen vanaf', 'Count from')}"></label>
        <a class="row" href="#/categorieen"><span class="row-main">${L('Categorieën', 'Categories')}</span>${bank.cats.length}${icon('next')}</a>
      </div>
      <p class="group-note">${L('Potjes en statistieken tellen alleen wat op of na deze datum is geboekt. Leeg betekent: alles.',
        'Pots and statistics only count what was booked on or after this date. Empty means: everything.')}</p>
      ${shareSection()}
      <h2 class="section">${L('Back-up', 'Backup')}</h2>
      <div class="group">
        <button class="row tint" data-action="export">${L('Back-up maken', 'Make a backup')}</button>
        <button class="row tint" data-action="import">${L('Terugzetten', 'Restore')}</button>
      </div>
      <p class="group-note">${sharing ? L('Alles staat op deze telefoon en, op slot, op de Kassa-server.', 'Everything is on this phone and, locked, on the Kassa server.')
        : L('Alles staat alleen op deze telefoon.', 'Everything is only on this phone.')} ${L(`Het back&#8209;upbestand bevat je kaartnummers en codes en al je
        bankgegevens, leesbaar voor wie het opent: bewaar het als contant geld.`, `The backup file holds your card
        numbers and codes and all your bank data, readable to whoever opens it: keep it as safe as cash.`)}</p>
      <h2 class="section">${L('Taal', 'Language')}</h2>
      <div class="group">
        ${L('<button class="row tint" data-action="language" lang="en">Use English</button>',
          '<button class="row tint" data-action="language" lang="nl">Nederlands gebruiken</button>')}
      </div>`,
  };
}

const KIND_NAMES = { out: L('Uitgaven', 'Spending'), in: L('Inkomen', 'Income'), none: L('Telt niet mee', 'Does not count') };

function categoriesScreen() {
  return {
    html: `
      <header class="navbar">
        <a class="back" href="#/meer">${icon('back')}${L('Instellingen', 'Settings')}</a>
        <h1>${L('Categorieën', 'Categories')}</h1>
        <button class="text-button" data-action="addCat">${L('Nieuw', 'New')}</button>
      </header>
      ${KIND_ORDER.map((kind) => `
        <h2 class="section">${KIND_NAMES[kind]}</h2>
        <ul class="group">${bank.cats.filter((cat) => cat.kind === kind).map((cat) => `
          <li><button class="row" data-action="editCat" data-id="${cat.id}"><span class="row-main">${esc(shown(cat.name))}</span>
            <span class="amount quiet">${cat.budget ? `${formatEuro(cat.budget)} ${L('per maand', 'a month')}` : ''}</span>${icon('next')}</button></li>`).join('')}</ul>`).join('')}
      <p class="group-note">${L('"Telt niet mee" is voor geld dat alleen verhuist, zoals tussen je eigen rekeningen.',
        '"Does not count" is for money that only moves, such as between your own accounts.')}</p>`,
  };
}

// "Betaling van € 5,00 verwijderen", for the trash button of a history entry and its confirmation
const removeEntryText = (entry) => L(`${KIND[entry.kind]} van ${formatEuro(Math.abs(entry.delta))} verwijderen`,
  `Delete ${KIND[entry.kind].toLowerCase()} of ${formatEuro(Math.abs(entry.delta))}`);

function cardScreen(card) {
  const left = balance(card);
  const history = [...card.entries].reverse().map((entry) => {
    const line = `<span class="row-main">${KIND[entry.kind]} <small>${formatDate(entry.at)}</small></span>
      ${entry.kind === 'start' ? formatEuro(entry.delta) : signed(entry.delta)}`;
    // a payment made through Betalen belongs to a purchase, and that is where it is changed or removed
    if (purchaseById(entry.purchase)) {
      return `<li><a class="row" href="#/uitgave/${entry.purchase}">${line}<span class="row-icon">${icon('next')}</span></a></li>`;
    }
    return `<li class="row">${line}${entry.kind === 'start' ? '<span class="row-icon"></span>' : `
      <button class="row-icon" data-action="undo" data-entry="${entry.id}"
        aria-label="${removeEntryText(entry)}">${icon('trash')}</button>`}</li>`;
  }).join('');
  return {
    html: `
      <header class="navbar">
        <a class="back" href="${left > 0 ? '#/kaarten' : '#/archief'}">${icon('back')}${left > 0 ? L('Kaarten', 'Cards') : L('Lege kaarten', 'Empty cards')}</a>
        <h1><span>${L('Kaart', 'Card')} </span>${last4(card)}</h1>
        <button class="text-button" data-action="edit">${L('Bewerken', 'Edit')}</button>
      </header>
      ${ticket(card)}
      <div class="saldo">
        <p class="total">${formatEuro(left)}</p>
        ${expiryHtml(card)}
      </div>
      ${left > 0 ? '' : `<p class="group-note">${L('Deze kaart is leeg en staat bij Lege kaarten.', 'This card is empty and is listed under Empty cards.')}</p>`}
      <div class="group">
        <button class="row tint" data-action="check"><span class="row-main">${L('Saldo checken', 'Check balance')}</span>${icon('out')}</button>
        <button class="row tint" data-action="correct">${L('Saldo corrigeren', 'Correct balance')}</button>
      </div>
      <h2 class="section">${L('Geschiedenis', 'History')}</h2>
      <ul class="group">${history}</ul>
      <div class="group">
        <button class="row danger" data-action="delete">${L('Verwijderen', 'Delete')}</button>
      </div>`,
    dock: left > 0 ? `<button class="button primary" data-action="payFrom">${L('Betalen met deze kaart', 'Pay with this card')}</button>` : '',
  };
}

function archiveScreen() {
  const spent = state.cards.filter((card) => balance(card) <= 0);
  const rows = spent.map((card) => `
    <li><a class="row" href="#/kaart/${card.id}">
      <span class="row-main">${last4(card)} <small>${expiryLabel(card)}</small></span>
      ${formatEuro(balance(card))}${icon('next')}
    </a></li>`).join('');
  return {
    html: `
      <header class="navbar">
        <a class="back" href="#/kaarten">${icon('back')}${L('Kaarten', 'Cards')}</a>
        <h1>${L('Lege kaarten', 'Empty cards')}</h1>
        <span></span>
      </header>
      ${spent.length ? `<ul class="group">${rows}</ul>` : blank(L('Geen lege kaarten', 'No empty cards'))}`,
  };
}

const installScreen = () => ({
  html: `
    <section class="install">
      <img src="icon-180.png" alt="" width="88" height="88">
      <h1>${L('Zet de app eerst op je beginscherm', 'Put the app on your Home Screen first')}</h1>
      <p>${L(`Safari kan de gegevens van een website na een week zonder gebruik wissen. Op je beginscherm
        blijven je kaarten bewaard.`, `Safari can erase a website's data after a week without use. On your Home Screen
        your cards stay saved.`)}</p>
      <ol class="group steps">
        <li class="row"><b aria-hidden="true">1</b><span>${L('Tik in Safari op <strong>Deel</strong> (het vierkant met de pijl omhoog).',
          'In Safari, tap <strong>Share</strong> (the square with the arrow pointing up).')}</span></li>
        <li class="row"><b aria-hidden="true">2</b><span>${L('Kies <strong>Zet op beginscherm</strong>.', 'Choose <strong>Add to Home Screen</strong>.')}</span></li>
        <li class="row"><b aria-hidden="true">3</b><span>${L('Open Kassa vanaf je beginscherm.', 'Open Kassa from your Home Screen.')}</span></li>
      </ol>
    </section>`,
});

// ---------- paying at the till ----------
// One payment walks through the cards in the order to use them. Nothing is saved until it is finished.
// `queue` holds the card ids; `steps` has one entry per card already passed: true = the till emptied it, false = skipped.
let paying = null;

const useOrder = () => sortCards(state.cards.filter((card) => balance(card) > 0)).map((card) => card.id);
const payCard = () => cardById(paying.queue[paying.steps.length]); // undefined once every card is passed
const emptiedCards = () => paying.queue.filter((id, index) => paying.steps[index]).map(cardById);

function payScreen() {
  const card = payCard();
  const back = paying.steps.length
    ? `<button class="back" data-action="payBack">${icon('back')}${L('Vorige', 'Previous')}</button>`
    : `<a class="back" href="#/kaarten">${icon('back')}${L('Kaarten', 'Cards')}</a>`;
  if (!card) {
    return {
      html: `
        <header class="navbar">${back}<h1>${L('Betalen', 'Pay')}</h1><span></span></header>
        ${blank(L('Geen kaarten meer', 'No cards left'), L('Betaal de rest met pin.', 'Pay the rest by debit card.'))}`,
      dock: `<button class="button primary" data-action="payDone">${L('Klaar', 'Done')}</button>`,
    };
  }
  return {
    html: `
      <header class="navbar">
        ${back}
        <h1><span>${L('Kaart', 'Card')} </span>${paying.steps.length + 1} ${L('van', 'of')} ${paying.queue.length}</h1>
        <button class="text-button" data-action="paySkip">${L('Overslaan', 'Skip')}</button>
      </header>
      ${ticket(card)}
      <div class="saldo">
        <p class="total">${formatEuro(balance(card))}</p>
        ${expiryHtml(card)}
      </div>`,
    dock: `
      <button class="button" data-action="payNext">${L('Volgende kaart', 'Next card')}</button>
      <button class="button primary" data-action="payDone">${L('Klaar', 'Done')}</button>`,
  };
}

const newEntry = (kind, delta) => ({ id: crypto.randomUUID(), at: new Date().toISOString(), kind, delta });
const newPurchase = (store, total, cards) => ({
  id: crypto.randomUUID(), at: new Date().toISOString(), store, total, cards, shares: [{ who: US, cents: total }],
});

// Ends a payment with the cards that were used: asks the total, records what each card lost and the
// purchase itself, and then asks who it was for. Whatever the cards could not cover went by pin.
async function finishPayment(cards) {
  const balances = cards.map(balance);
  const earlier = balances.slice(0, -1).reduce((sum, cents) => sum + cents, 0);
  const total = await askAmount(L('Afronden', 'Finish'), L('Totaalbedrag', 'Total amount'), (cents) => {
    if (settle(balances, cents) !== 'low') return '';
    return earlier
      ? L(`Dat dekten de vorige kaarten al (${formatEuro(earlier)}). Ga terug met Vorige.`,
        `The previous cards already covered that (${formatEuro(earlier)}). Go back with Previous.`)
      : ENTER_AMOUNT;
  });
  if (total === null) return;
  const taken = settle(balances, total);
  const fromCards = taken.reduce((sum, cents) => sum + cents, 0);
  const purchase = newPurchase('AH', total, fromCards);
  cards.forEach((card, index) => card.entries.push({ ...newEntry('pay', -taken[index]), purchase: purchase.id }));
  state.purchases.push(purchase);
  save();
  toast(!fromCards ? L(`${formatEuro(total)} vastgelegd.`, `${formatEuro(total)} recorded.`)
    : total > fromCards ? L(`${formatEuro(fromCards)} met kaarten, ${formatEuro(total - fromCards)} met pin.`,
      `${formatEuro(fromCards)} by gift card, ${formatEuro(total - fromCards)} by debit card.`)
    : L(`${formatEuro(fromCards)} afgeschreven van ${plural(cards.length, 'kaart', 'kaarten')}.`,
      `${formatEuro(fromCards)} taken from ${plural(cards.length, 'card', 'cards')}.`));
  goCards();
  askWho(purchase);
}

// ---------- purchases and statistics ----------

let stats = { unit: 'month', start: periodStart('month', new Date()) }; // the period on the statistics screen

const periodName = (unit, start) => (unit === 'week' ? `Week ${isoWeek(start)}`
  : unit === 'month' ? start.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' })
  : String(start.getFullYear()));
const periodShort = (unit, start) => (unit === 'week' ? String(isoWeek(start))
  : unit === 'month' ? start.toLocaleDateString(LOCALE, { month: 'short' }).replace('.', '')
  : String(start.getFullYear()));

// The last few periods of gift card payments as columns
function trendChart(unit, chosen) {
  const now = periodStart(unit, new Date());
  // the chart ends at the current period, unless an older one is chosen: then it ends there
  const end = chosen < shiftPeriod(unit, now, 1 - SPAN[unit]) ? chosen : now;
  return columnChart(Array.from({ length: SPAN[unit] }, (unused, index) => {
    const start = shiftPeriod(unit, end, index + 1 - SPAN[unit]);
    return {
      id: start.getTime(), name: periodName(unit, start), short: periodShort(unit, start),
      total: summarize(state.purchases, start, shiftPeriod(unit, start, 1)).total, chosen: start.getTime() === chosen.getTime(),
    };
  }), 'statPick');
}

// One row per person or shop: name, amount, share, and a bar for that share of the period.
const meters = (pairs, total) => pairs.map(([name, cents]) => `
  <li class="row meter-row">
    <span class="row-main">${esc(shown(name))}</span>
    <span>${formatEuro(cents)} <small>${Math.round(cents / total * 100)}%</small></span>
    ${meterBar(cents / total, { rank: true })}
  </li>`).join('');

function statsScreen() {
  const { unit, start } = stats;
  const sum = summarize(state.purchases, start, shiftPeriod(unit, start, 1));
  const lastDay = shiftPeriod(unit, start, 1);
  lastDay.setDate(lastDay.getDate() - 1);
  const isCurrent = start.getTime() === periodStart(unit, new Date()).getTime();
  const rows = sum.purchases.map((purchase) => `
    <li><a class="row" href="#/uitgave/${purchase.id}">
      <span class="row-main">${esc(shown(purchase.store))} <small>${formatDate(purchase.at)} · ${esc(whoText(purchase))}</small></span>
      ${formatEuro(purchase.total)}${icon('next')}
    </a></li>`).join('');
  return {
    html: `
      <header class="navbar">
        <a class="back" href="#/kaarten">${icon('back')}${L('Kaarten', 'Cards')}</a>
        <h1>${L('Bij de kassa', 'At the till')}</h1>
        <span></span>
      </header>
      <div class="segments" role="group" aria-label="${L('Periode', 'Period')}">
        ${Object.entries(UNITS).map(([key, label]) => `
          <button data-action="statUnit" data-unit="${key}" aria-pressed="${key === unit}">${label}</button>`).join('')}
      </div>
      <section class="summary period">
        <div class="stepper">
          <button data-action="statStep" data-by="-1" aria-label="${L('Vorige periode', 'Previous period')}">${icon('back')}</button>
          <h2>${periodName(unit, start)}${unit === 'week' ? `
            <small>${start.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })} ${L('t/m', 'to')} ${formatDate(lastDay)}</small>` : ''}</h2>
          <button data-action="statStep" data-by="1" aria-label="${L('Volgende periode', 'Next period')}"${isCurrent ? ' disabled' : ''}>${icon('next')}</button>
        </div>
        <p class="total">${formatEuro(sum.total)}</p>
        ${trendChart(unit, start)}
      </section>
      ${sum.purchases.length ? `
        <h2 class="section">${L('Voor wie', 'For whom')}</h2>
        <ul class="group">${meters(sum.byWho, sum.total)}</ul>
        <h2 class="section">${L('Winkels', 'Shops')}</h2>
        <ul class="group">${meters(sum.byStore, sum.total)}</ul>
        <h2 class="section">${L('Betaald met', 'Paid with')}</h2>
        ${paidWith(sum.cards, sum.total)}
        <h2 class="section">${L('Betalingen', 'Payments')}</h2>
        <ul class="group">${rows}</ul>`
      : blank(L('Geen betalingen', 'No payments'), L('In deze periode is niets met de kaarten betaald.', 'Nothing was paid with the cards in this period.'))}`,
  };
}

function purchaseScreen(purchase) {
  const day = new Date(purchase.at).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return {
    html: `
      <header class="navbar">
        <a class="back" href="#/uitgaven">${icon('back')}${L('Bij de kassa', 'At the till')}</a>
        <h1>${esc(shown(purchase.store))}</h1>
        <button class="text-button" data-action="editPurchase">${L('Bewerken', 'Edit')}</button>
      </header>
      <section class="summary">
        <p class="footnote">${day}</p>
        <p class="total">${formatEuro(purchase.total)}</p>
      </section>
      <h2 class="section">${L('Voor wie', 'For whom')}</h2>
      <div class="group">
        ${purchase.shares.map((share) => `
          <p class="row"><span class="row-main">${esc(shown(share.who))}</span>${formatEuro(share.cents)}</p>`).join('')}
        <button class="row tint" data-action="who">${L('Wijzigen', 'Change')}</button>
      </div>
      <h2 class="section">${L('Betaald met', 'Paid with')}</h2>
      ${paidWith(purchase.cards, purchase.total)}
      <div class="group">
        <button class="row danger" data-action="deletePurchase">${L('Verwijderen', 'Delete')}</button>
      </div>`,
  };
}

// ---------- which screen ----------

const route = () => location.hash.split('/')[1] ?? ''; // "#/kaart/<id>" -> "kaart"
const routeId = () => location.hash.split('/')[2];
const currentCard = () => (route() === 'kaart' ? cardById(routeId()) : undefined);
const currentPurchase = () => (route() === 'uitgave' ? purchaseById(routeId()) : undefined);

const SCREENS = {
  potjes: potsScreen, kaarten: cardsScreen, kaart: cardsScreen, betalen: cardsScreen, archief: archiveScreen, uitgaven: statsScreen, uitgave: statsScreen,
  inzicht: insightScreen, transacties: transactionsScreen, meer: settingsScreen, categorieen: categoriesScreen, vast: fixedScreen,
  categorie: () => categoryScreen(routeId()),
  saldo: () => balanceScreen(accountById(routeId())),
};
// how deep the current address sits, which decides whether a change slides forward or back; the tabs are 0
const DEPTH = { meer: 1, vast: 1, categorie: 1, archief: 1, uitgaven: 1, kaart: 1, categorieen: 2, uitgave: 2, saldo: 2, betalen: 3 };
const depth = () => DEPTH[route()] ?? 0;
let shownDepth = 0;
let tapped = false; // true when a tap inside the app caused the navigation

// The tab bar. Betalen starts a payment at once when there is a card to pay with.
const TABS = [
  ['overzicht', '#/', 'home', L('Overzicht', 'Overview')],
  ['potjes', '#/potjes', 'pot', L('Potjes', 'Pots')],
  ['betalen', '#/kaarten', 'scan', L('Betalen', 'Pay')],
  ['inzicht', '#/inzicht', 'chart', L('Inzicht', 'Insight')],
  ['transacties', '#/transacties', 'list', L('Transacties', 'Transactions')],
];
const TAB_OF = {
  '': 'overzicht', meer: 'overzicht', categorieen: 'overzicht', potjes: 'potjes',
  kaarten: 'betalen', kaart: 'betalen', betalen: 'betalen', archief: 'betalen', uitgaven: 'betalen', uitgave: 'betalen',
  inzicht: 'inzicht', transacties: 'transacties',
};
let tab = 'overzicht'; // a category and the fixed costs are reached from several tabs and keep the one they came from

const tabsHtml = () => TABS.map(([id, address, glyph, label]) => `
  <a class="tab${id === 'betalen' ? ' pay-tab' : ''}" href="${id === 'betalen' && useOrder().length ? '#/betalen' : address}"${id === tab ? ' aria-current="page"' : ''}>
    ${icon(glyph)}<span>${label}</span></a>`).join('');

function render() {
  const card = currentCard();
  const purchase = currentPurchase();
  // a payment lives only while its screen is open; it starts with the cards in the order to use them
  if (route() !== 'betalen') paying = null;
  else paying ??= { queue: useOrder(), steps: [] };
  const atTill = Boolean(card || paying?.queue.length); // the screens a till scanner reads stay white
  const install = needsInstall(navigator.userAgent, standalone);
  tab = TAB_OF[route()] ?? tab;
  const screen = install ? installScreen()
    : card ? cardScreen(card)
    : atTill ? payScreen()
    : purchase ? purchaseScreen(purchase)
    : (SCREENS[route()] ?? overviewScreen)();
  document.body.classList.toggle('pay', atTill);
  app.innerHTML = screen.html;
  $('dock').innerHTML = screen.dock ?? '';
  $('dock').hidden = !screen.dock;
  // the tab bar makes room for the screens the till reads: there the dock has the thumb
  $('tabs').innerHTML = tabsHtml();
  $('tabs').hidden = atTill || install;
  shownDepth = depth();
  // the iPhone status bar takes the colour of the screen below it
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.body).backgroundColor;
}

// Draws the screen for the current address and lets screen readers and keyboards start at its top.
function show() {
  render();
  scrollTo(0, 0);
  app.focus({ preventScroll: true });
}

// Redraws the same screen after a control on it was used, and hands the focus back to that control.
function redraw(control) {
  render();
  const again = document.querySelector(control);
  if (again && !again.disabled) again.focus({ preventScroll: true });
  else app.focus({ preventScroll: true });
}

// Changes the screen with an iPhone-style slide ('push' forward, 'pop' back) where the browser can.
function slide(nav, change) {
  if (!document.startViewTransition || reducedMotion.matches) {
    change();
    return;
  }
  document.documentElement.dataset.nav = nav;
  document.startViewTransition(change);
}

function go(address) {
  tapped = true;
  location.hash = address;
}

function goCards() {
  tapped = depth() > 0;
  location.hash = '#/kaarten';
}

// ---------- dialogs ----------

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 4000);
}

// Lets a sheet slide away before it closes; CSS alone cannot animate a closing <dialog> in Safari.
function closeDialog(dialog, value = '') {
  if (reducedMotion.matches) {
    dialog.close(value);
    return;
  }
  dialog.classList.add('closing'); // style.css runs the slide; without motion the branch above applies
  dialog.addEventListener('animationend', () => {
    dialog.classList.remove('closing');
    dialog.close(value);
  }, { once: true });
}

// Shows a dialog; resolves with how it closed: 'ok' once its form is submitted and `check` returns no
// error message, or '' when cancelled.
function openDialog(dialog, check = () => '') {
  const error = dialog.querySelector('.error');
  if (error) error.textContent = '';
  return new Promise((resolve) => {
    dialog.querySelector('form').onsubmit = (event) => {
      event.preventDefault(); // closeDialog does the closing, after the slide
      const message = check();
      if (message) error.textContent = message;
      else closeDialog(dialog, 'ok');
    };
    dialog.oncancel = (event) => {
      event.preventDefault();
      closeDialog(dialog);
    };
    dialog.onclose = () => resolve(dialog.returnValue);
    dialog.returnValue = '';
    dialog.showModal();
  });
}

// Asks to confirm. The button is red, as most of these delete something; `safe` makes it the plain blue.
async function ask(text, okLabel, safe = false) {
  $('confirmText').textContent = text;
  $('confirmOk').textContent = okLabel;
  $('confirmOk').className = safe ? 'row tint' : 'row danger';
  return await openDialog($('confirmDialog')) === 'ok';
}

// Resolves with the entered amount in cents, or null when cancelled.
async function askAmount(title, label, check = () => '') {
  const form = $('amountDialog').querySelector('form');
  form.reset();
  $('amountTitle').textContent = title;
  $('amountLabel').textContent = label;
  let cents;
  const answer = await openDialog($('amountDialog'), () => {
    cents = parseEuro(form.elements.amount.value);
    return cents === null ? ENTER_AMOUNT : check(cents);
  });
  return answer === 'ok' ? cents : null;
}

// Asks who an amount of `total` cents was for, starting from the `current` shares; `note` says what it is about.
// One name takes everything; with Verdelen on, the other names get the amounts typed behind them and the chosen
// name gets what is left. Resolves with the new shares, or null when cancelled.
async function pickShares(total, note, current) {
  const form = $('whoDialog').querySelector('form');
  const main = current[0].who; // shares are kept largest first
  const part = (who) => (who === main ? '' : euroInput(current.find((share) => share.who === who)?.cents ?? 0)).replace(/^0[,.]00$/, '');
  const choice = (who, name) => `
    <label class="row choice">
      <input type="radio" name="who" value="${esc(who)}"${who === main ? ' checked autofocus' : ''}>
      ${name}${icon('check')}
      <input class="part" data-who="${esc(who)}" inputmode="decimal" autocomplete="off" placeholder="${L('0,00', '0.00')}"
        value="${part(who)}" aria-label="${L('Bedrag voor', 'Amount for')} ${esc(shown(who)) || L('de andere naam', 'the other name')}">
    </label>`;
  $('whoNote').textContent = note;
  const otherName = L('Andere naam', 'Other name');
  $('whoNames').innerHTML = people().map((who) => choice(who, `<span class="row-main">${esc(shown(who))}</span>`)).join('')
    + choice('', `<input class="row-main" name="other" maxlength="30" autocomplete="off" placeholder="${otherName}" aria-label="${otherName}">`);
  form.elements.split.checked = current.length > 1;
  const other = form.elements.other;
  other.oninput = () => { other.closest('label').querySelector('[type="radio"]').checked = true; }; // typing a new name chooses it
  let shares;
  const answer = await openDialog($('whoDialog'), () => {
    const typed = other.value.trim();
    const chosen = form.elements.who.value || typed;
    if (!isName(chosen)) return L('Kies een naam of vul er een in.', 'Choose a name or type one.');
    const parts = [];
    for (const input of form.elements.split.checked ? form.querySelectorAll('.part') : []) {
      const who = input.dataset.who || typed;
      const cents = input.value.trim() ? parseEuro(input.value) : 0;
      if (cents === null) return L('Vul bedragen in zoals 12,50.', 'Enter amounts like 12.50.');
      if (cents && !isName(who)) return L('Vul een naam in bij het bedrag.', 'Type a name with the amount.');
      if (cents && who !== chosen) parts.push([who, cents]);
    }
    shares = shareOut(total, chosen, parts);
    return shares === 'over' ? L(`Dat is samen meer dan ${formatEuro(total)}.`, `That adds up to more than ${formatEuro(total)}.`) : '';
  });
  return answer === 'ok' ? shares : null;
}

// Asks who a purchase was for and saves the answer.
async function askWho(purchase) {
  const shares = await pickShares(purchase.total, `${formatEuro(purchase.total)} ${L('bij', 'at')} ${shown(purchase.store)}`, purchase.shares);
  if (!shares) return;
  purchase.shares = shares;
  save();
}

// Asks which shop a payment for gift cards was for and what the cards are worth. The app's own guess is filled
// in when the price fits a shop bought before; choosing another shop fills in the value its discount gives.
// `more` is how many payments wait after this one. Resolves with { shop, value }, or null when cancelled.
async function pickGift(tx, current, more = 0) {
  const form = $('giftDialog').querySelector('form');
  const guesses = giftGuesses(bank, -tx.cents);
  if (!guesses.some((guess) => guess.shop === AH)) guesses.push({ shop: AH, value: 0 });
  const first = current ?? (guesses[0].value % 500 === 0 && guesses[0].value > 0 ? guesses[0] : { shop: '', value: 0 });
  const listed = guesses.some((guess) => guess.shop === first.shop);
  const otherShop = L('Andere winkel', 'Other shop');
  const choice = (shop, label, chosen) => `
    <label class="row choice"><input type="radio" name="shop" value="${esc(shop)}"${chosen ? ' checked' : ''}>${label}${icon('check')}</label>`;
  $('giftNote').textContent = `${formatEuro(-tx.cents)} ${L('betaald aan', 'paid to')} ${tx.name} ${L('op', 'on')} ${dayShort(tx.date)}${
    more ? ` · ${L(`hierna nog ${more}`, `${more} more after this`)}` : ''}`;
  $('giftShops').innerHTML = guesses.map(({ shop }) => choice(shop, `<span class="row-main">${esc(shop)}</span>`, shop === first.shop)).join('')
    + choice('', `<input class="row-main" name="other" maxlength="30" autocomplete="off" placeholder="${otherShop}" aria-label="${otherShop}"
      value="${listed ? '' : esc(first.shop)}">`, !listed && Boolean(first.shop));
  const { other, value } = form.elements;
  value.value = first.value ? euroInput(first.value) : '';
  other.oninput = () => { other.closest('label').querySelector('[type="radio"]').checked = true; }; // typing a new shop chooses it
  $('giftShops').onchange = () => {
    const guess = guesses.find((each) => each.shop === form.elements.shop.value);
    if (guess?.value) value.value = euroInput(guess.value);
  };
  let gift;
  const answer = await openDialog($('giftDialog'), () => {
    const typed = form.elements.shop.value || other.value.trim();
    const shop = guesses.find((guess) => guess.shop.toLowerCase() === typed.toLowerCase())?.shop ?? typed; // one spelling per shop
    if (!isName(shop)) return L('Kies een winkel of vul er een in.', 'Choose a shop or type one.');
    if (!parseEuro(value.value)) return ENTER_AMOUNT;
    gift = { shop, value: parseEuro(value.value) };
    return '';
  });
  return answer === 'ok' ? gift : null;
}

// Sorts a transaction: a category for it alone, or for everything from its counterparty, and whether
// that counterparty is a fixed cost. Groceries can also be split between people, as a gift card payment can,
// and a payment for gift cards can say what it bought.
async function askTx(tx) {
  const form = $('txDialog').querySelector('form');
  const key = ruleKey(tx.name); // empty for a name without letters: then there is nothing to hang a rule on
  const before = sorter(bank)(tx);
  $('txFacts').innerHTML = `
    <p class="row"><span class="row-main">${esc(tx.name)} <small>${formatDate(tx.date, 'UTC')} · ${esc(nameOf(accountById(tx.acc)))}</small></span>
      <span class="amount${tx.cents > 0 ? ' plus' : ''}">${signed(tx.cents)}</span></p>
    ${tx.text ? `<p class="row"><small class="row-main selectable">${esc(tx.text)}</small></p>` : ''}`;
  const choice = (id, name) => `
    <label class="row choice"><input type="radio" name="cat" value="${id}"${id === before ? ' checked' : ''}>
      <span class="row-main">${name}</span>${icon('check')}</label>`;
  $('txCats').innerHTML = sortedCats().map((cat) => choice(cat.id, esc(shown(cat.name)))).join('') + choice('', L('Nog niet indelen', 'Leave unsorted'));
  const { all, fixed } = form.elements;
  $('txAllRow').hidden = !key;
  $('txAllLabel').textContent = L(`Ook al het andere van ${tx.name}`, `Everything else from ${tx.name} too`);
  all.checked = Boolean(key) && tx.cat === undefined;
  $('txFixedRow').hidden = !key || tx.cents >= 0;
  fixed.checked = bank.fixed[key] === true;
  // "Voor wie?" shows while Boodschappen is the chosen category; the answer is kept here until the sheet is saved
  let shares = tx.shares ?? [{ who: US, cents: -tx.cents }];
  const showWho = () => {
    $('txWhoGroup').hidden = tx.cents >= 0 || form.elements.cat.value !== 'boodschappen';
    $('txWhoNow').textContent = shares.map((share) => shown(share.who)).join(', ');
  };
  // "Cadeaukaart" shows while the gift card category is chosen, and on a card that counts somewhere else as long
  // as it stays there; sorting a payment out of where it was says it bought no card after all
  let { gift } = tx;
  const keepsGift = () => tx.cents < 0 && (form.elements.cat.value === 'cadeaukaarten' || (Boolean(gift) && form.elements.cat.value === before));
  const showGift = () => {
    $('txGiftGroup').hidden = !keepsGift();
    $('txGiftNow').textContent = gift ? `${gift.shop} · ${formatEuro(gift.value)}` : L('Invullen', 'Fill in');
  };
  $('txCats').onchange = () => { showWho(); showGift(); };
  $('txWho').onclick = async () => {
    shares = await pickShares(-tx.cents, `${formatEuro(-tx.cents)} ${L('bij', 'at')} ${tx.name}`, shares) ?? shares;
    showWho();
  };
  $('txGift').onclick = async () => {
    gift = await pickGift(tx, gift) ?? gift;
    showGift();
  };
  showWho();
  showGift();
  $('txDeleteGroup').hidden = !accountById(tx.acc)?.shop; // only what was entered by hand can be taken out again
  const answer = await openDialog($('txDialog'));
  if (answer === 'delete' && await ask(L(`${signed(tx.cents)} voor ${tx.name} verwijderen?`, `Delete ${signed(tx.cents)} for ${tx.name}?`), L('Verwijderen', 'Delete'))) {
    bank.txs = bank.txs.filter((each) => each !== tx);
    saveBank();
  }
  if (answer !== 'ok') return;
  const cat = form.elements.cat.value;
  if (keepsGift() && gift) tx.gift = gift;
  else delete tx.gift;
  if (cat === 'boodschappen' && tx.cents < 0 && shares.some((share) => share.who !== US)) tx.shares = shares;
  else delete tx.shares;
  if (all.checked) {
    if (cat) bank.rules[key] = cat;
    else delete bank.rules[key];
    const same = bank.txs.filter((each) => ruleKey(each.name) === key);
    for (const each of same) delete each.cat;
    if (same.length > 1) toast(L(`${same.length} transacties van ${tx.name} ingedeeld.`, `${same.length} transactions from ${tx.name} sorted.`));
  } else if (cat) tx.cat = cat;
  else delete tx.cat;
  if (!$('txFixedRow').hidden && fixed.checked !== (bank.fixed[key] === true)) bank.fixed[key] = fixed.checked;
  saveBank();
}

// Asks for a payment from a shop's balance: once, or every month from its date on. A name the app has not
// seen is sorted at once, so every later payment of that name follows.
async function askPayment(account) {
  const form = $('payDialog').querySelector('form');
  form.reset();
  form.elements.date.value = isoDate();
  $('payNote').textContent = L(`Uit het saldo bij ${account.shop}`, `From the balance at ${account.shop}`);
  let pay;
  const answer = await openDialog($('payDialog'), () => {
    const { name, amount, date, monthly } = form.elements;
    pay = { name: name.value.trim(), cents: parseEuro(amount.value), date: date.value, monthly: monthly.checked };
    if (!isName(pay.name)) return L('Vul in waarvoor het was.', 'Enter what it was for.');
    if (!pay.cents) return ENTER_AMOUNT;
    if (!isDate(pay.date)) return ENTER_DATE;
    return !pay.monthly && pay.date > isoDate() ? L('Kies vandaag of een eerdere dag.', 'Choose today or an earlier day.') : '';
  });
  if (answer !== 'ok') return;
  if (pay.monthly) account.monthly.push({ name: pay.name, cents: -pay.cents, day: Number(pay.date.slice(8)), next: monthOf(pay.date) });
  const [first] = pay.monthly ? catchUp(bank, isoDate()) : [payFrom(bank, account, pay.date, -pay.cents, pay.name)];
  saveBank();
  if (first && !sorter(bank)(first)) await askTx(first);
}

// Adds a category, or edits `cat` when given. An amount per month makes a spending category a pot.
async function editCat(cat) {
  const form = $('catDialog').querySelector('form');
  const field = form.elements;
  form.reset();
  const builtIn = Boolean(cat) && START_IDS.has(cat.id); // the app counts on these: they can be renamed, nothing else
  $('catTitle').textContent = cat ? L('Categorie bewerken', 'Edit category') : L('Nieuwe categorie', 'New category');
  field.name.value = cat?.name ?? '';
  field.kind.value = cat?.kind ?? 'out';
  field.kind.disabled = builtIn;
  field.budget.value = cat?.budget ? euroInput(cat.budget) : '';
  field.kind.onchange = () => { $('catBudgetField').hidden = field.kind.value !== 'out'; };
  field.kind.onchange();
  $('catDeleteGroup').hidden = !cat || builtIn;
  const usual = cat?.kind === 'out' ? average([1, 2, 3].map((back) => monthFigures(shiftMonth(thisMonth(), -back)).byCat.get(cat.id) ?? 0)) : 0;
  $('catHint').textContent = usual > 0 ? L(`De laatste drie maanden ging hier gemiddeld ${formatEuro(usual)} per maand aan op.`,
    `Over the last three months this took ${formatEuro(usual)} a month on average.`) : '';
  let next;
  const answer = await openDialog($('catDialog'), () => {
    next = { name: field.name.value.trim(), kind: field.kind.value, budget: field.budget.value.trim() ? parseEuro(field.budget.value) : 0 };
    if (!isName(next.name)) return L('Vul een naam in.', 'Enter a name.');
    if (bank.cats.some((other) => other !== cat && other.name.toLowerCase() === next.name.toLowerCase())) return L('Deze categorie bestaat al.', 'This category already exists.');
    if (next.budget === null) return ENTER_AMOUNT;
    return '';
  });
  if (answer === 'delete') {
    const sure = await ask(L(`Categorie ${cat.name} verwijderen? Wat erin zat, moet opnieuw worden ingedeeld.`,
      `Delete the category ${cat.name}? What was in it has to be sorted again.`), L('Verwijderen', 'Delete'));
    if (!sure) return;
    bank.cats = bank.cats.filter((other) => other !== cat);
    for (const [key, id] of Object.entries(bank.rules)) if (id === cat.id) delete bank.rules[key];
    for (const tx of bank.txs) if (tx.cat === cat.id) delete tx.cat;
    saveBank();
    if (route() === 'categorie') actions.back();
    return;
  }
  if (answer !== 'ok') return;
  const { budget, ...rest } = next;
  const saved = cat ?? bank.cats[bank.cats.push({ id: `c-${crypto.randomUUID().slice(0, 8)}` }) - 1];
  Object.assign(saved, rest);
  if (budget && saved.kind === 'out') saved.budget = budget;
  else delete saved.budget;
  saveBank();
}

// Resolves with the entered text, or null when cancelled.
// Asks for a line of text: a name, unless `check` says otherwise (it returns an error message, or '' when fine).
async function askText(title, label, value, { check = (text) => (isName(text) ? '' : L('Vul een naam in.', 'Enter a name.')), max = 30, ok = L('Opslaan', 'Save') } = {}) {
  const form = $('textDialog').querySelector('form');
  $('textTitle').textContent = title;
  $('textLabel').textContent = label;
  form.elements.text.value = value;
  form.elements.text.maxLength = max;
  form.querySelector('[value="ok"]').textContent = ok;
  let text;
  const answer = await openDialog($('textDialog'), () => {
    text = form.elements.text.value.trim();
    return check(text);
  });
  return answer === 'ok' ? text : null;
}

// ---------- bank files ----------

// The pieces of text of a PDF with their place on the page. The PDF reader is large, so it is only loaded here.
async function pdfItems(bytes) {
  const pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs';
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const items = [];
  for (let page = 1; page <= pdf.numPages; page++) {
    const { items: texts } = await (await pdf.getPage(page)).getTextContent();
    for (const text of texts) items.push({ page, x: text.transform[4], y: text.transform[5], str: text.str });
  }
  return items;
}

// Reads the chosen files: bank exports, and a starter file (categories and rules, and maybe bank files read already
// and gift cards to add). Each file is taken whole or not at all.
async function importBankFiles() {
  // a starter file names accounts and sorts transactions that must be there first, so it is read after the bank files
  const files = [...$('bankFiles').files].sort((a, b) => a.name.endsWith('.json') - b.name.endsWith('.json'));
  $('bankFiles').value = '';
  if (!files.length) return;
  toast(L('Bestanden lezen…', 'Reading files…'));
  const now = new Date().toISOString();
  const failed = [];
  let added = 0;
  let changed = false;
  let starter = false;
  let newCards = 0;
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isPdf = String.fromCharCode(...bytes.subarray(0, 4)) === '%PDF';
      const text = isPdf ? '' : decodeText(bytes);
      if (isPdf) added += addFile(bank, readOpenbank(await pdfItems(bytes)), now);
      else if (text.trimStart().startsWith('{')) {
        const data = JSON.parse(text);
        const cards = data.cards ? parseState(JSON.stringify({ cards: data.cards })).cards : []; // throws on a card that is not one
        const fresh = addStarter(bank, data, now);
        if (fresh === null) throw new Error('unknown');
        added += fresh;
        newCards += addCards(state, cards); // only cards the app does not have; the ones it has are never touched
        starter = true;
      } else added += addFile(bank, readCsv(text), now);
      changed = true;
    } catch {
      failed.push(file.name);
    }
  }
  if (changed) {
    catchUp(bank, isoDate());
    state.needsBackup = true;
    localStorage.setItem(KEY, JSON.stringify(state));
    saveBank();
  }
  const news = !changed ? '' : added ? L(`${plural(added, 'nieuwe transactie', 'nieuwe transacties')} toegevoegd.`, `${plural(added, 'new transaction', 'new transactions')} added.`)
    : starter ? L('Categorieën en regels toegevoegd.', 'Categories and rules added.')
    : L('Niets nieuws: alles stond er al in.', 'Nothing new: it was all there already.');
  const cardNews = newCards ? L(`${plural(newCards, 'kaart', 'kaarten')} toegevoegd.`, `${plural(newCards, 'card', 'cards')} added.`) : '';
  const toFill = changed ? giftsToFill(bank).length : 0;
  const giftNews = toFill ? L(`Vul op Overzicht nog ${plural(toFill, 'cadeaukaart', 'cadeaukaarten')} in.`, `${plural(toFill, 'gift card', 'gift cards')} to fill in on Overview.`) : '';
  toast([news, cardNews, giftNews, failed.length ? `${L('Niet gelezen', 'Not read')}: ${failed.join(', ')}.` : ''].filter(Boolean).join(' '));
}

// ---------- actions ----------

// Adds a card, or edits `card` when given.
async function editCard(card) {
  const form = $('cardDialog').querySelector('form');
  const field = form.elements;
  form.reset();
  $('cardTitle').textContent = card ? L('Kaart bewerken', 'Edit card') : L('Kaart toevoegen', 'Add card');
  field.start.closest('label').hidden = Boolean(card); // the balance of an existing card changes through its history
  if (card) {
    field.number.value = groupNumber(card.number);
    field.code.value = card.code;
    field.expiry.value = card.expiry;
  }
  let next;
  const answer = await openDialog($('cardDialog'), () => {
    next = {
      number: cleanDigits(field.number.value),
      code: cleanDigits(field.code.value),
      expiry: field.expiry.value,
      start: parseEuro(field.start.value),
    };
    if (!validNumber(next.number)) return L('Het kaartnummer moet 19 cijfers hebben.', 'The card number must have 19 digits.');
    if (!validCode(next.code)) return L('De beveiligingscode moet 6 cijfers hebben.', 'The security code must have 6 digits.');
    if (state.cards.some((other) => other !== card && other.number === next.number)) return L('Deze kaart staat er al in.', 'This card is already in the app.');
    if (!card && !next.start) return L('Vul het saldo in, bijvoorbeeld 25,00.', 'Enter the balance, for example 25.00.');
    if (next.expiry && !isDate(next.expiry)) return ENTER_DATE;
    return '';
  });
  if (answer !== 'ok') return;
  const { number, code, expiry, start } = next;
  if (!card) {
    state.cards.push({ id: crypto.randomUUID(), number, code, expiry, entries: [newEntry('start', start)] });
    state.needsBackup = true;
  } else {
    if (card.number !== number || card.code !== code) state.needsBackup = true;
    Object.assign(card, { number, code, expiry });
  }
  save();
}

// Edits a purchase. New ones only come from paying with cards: what was paid by pin is on the bank statement.
async function editPurchase(purchase) {
  const form = $('purchaseDialog').querySelector('form');
  const field = form.elements;
  form.reset();
  $('purchaseTitle').textContent = L('Uitgave bewerken', 'Edit purchase');
  // a purchase saved with a shop from before this list keeps that shop
  const choices = SHOPS.includes(purchase.store) ? SHOPS : [...SHOPS, purchase.store];
  field.store.innerHTML = choices.map((shop) => `<option value="${esc(shop)}">${esc(shown(shop))}</option>`).join('');
  field.store.value = purchase.store;
  const before = isoDate(new Date(purchase.at));
  field.total.value = euroInput(purchase.total);
  field.date.value = before;
  let next;
  const answer = await openDialog($('purchaseDialog'), () => {
    next = { store: field.store.value.trim(), total: parseEuro(field.total.value), date: field.date.value };
    if (!isName(next.store)) return L('Kies de winkel.', 'Choose the shop.');
    if (!next.total) return L('Vul het bedrag in, bijvoorbeeld 25,00.', 'Enter the amount, for example 25.00.');
    if (next.total < purchase.cards) {
      return L(`Minstens ${formatEuro(purchase.cards)}: zoveel is met cadeaukaarten betaald.`,
        `At least ${formatEuro(purchase.cards)}: that much was paid with gift cards.`);
    }
    if (!isDate(next.date)) return ENTER_DATE;
    return '';
  });
  if (answer !== 'ok') return;
  // the time of day is kept unless the date changed; another day counts as noon that day
  const at = next.date === before ? purchase.at : new Date(`${next.date}T12:00`).toISOString();
  const wasSplit = purchase.shares.length > 1;
  const resized = next.total !== purchase.total;
  Object.assign(purchase, { store: next.store, at, total: next.total });
  if (resized) purchase.shares = [{ who: purchase.shares[0].who, cents: next.total }]; // a new total needs a new split
  save();
  if (resized && wasSplit) askWho(purchase);
}

async function exportBackup() {
  const name = `kassa-backup-${isoDate()}.json`;
  const { cards, purchases } = state;
  const json = JSON.stringify({ app: 'kassa', version: 2, exportedAt: new Date().toISOString(), cards, purchases, bank });
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] }); // the iPhone share sheet, e.g. "Bewaar in Bestanden"
    } else {
      Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name }).click();
    }
  } catch {
    return; // share sheet dismissed: nothing was saved, so keep the reminder
  }
  state.needsBackup = false;
  save();
}

async function importBackup() {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  let next;
  let nextBank; // a backup from before the bank side has none: then the bank data in the app stays
  try {
    const text = await file.text();
    next = parseState(text);
    const saved = JSON.parse(text).bank;
    if (saved) nextBank = parseBank(saved);
  } catch {
    toast(L('Dit is geen geldige back-up van Kassa.', 'This is not a valid Kassa backup.'));
    return;
  }
  const sure = await ask(
    L(`Back-up met ${next.cards.length} kaarten${nextBank ? ` en ${nextBank.txs.length} transacties` : ''} terugzetten? Dit vervangt de kaarten en kassabetalingen${nextBank ? ' en alle bankgegevens' : ''} die nu in de app staan.`,
      `Restore the backup with ${next.cards.length} cards${nextBank ? ` and ${nextBank.txs.length} transactions` : ''}? This replaces the cards and till payments${nextBank ? ' and all bank data' : ''} now in the app.`),
    L('Terugzetten', 'Restore'),
  );
  if (!sure) return;
  state = { ...next, needsBackup: false };
  if (nextBank) bank = nextBank;
  localStorage.setItem(KEY, JSON.stringify(state));
  saveBank();
  go('#/');
}

// Each action gets the card of the current screen (if any) and the element that was tapped.
const actions = {
  add: () => editCard(),
  edit: (card) => editCard(card),
  close: (card, button) => closeDialog(button.closest('dialog')),
  export: exportBackup,
  import: () => $('importFile').click(),
  share: startSharing,
  joinShare: joinSharing,
  invite,
  async syncNow() {
    await sync();
    render();
    if (syncError) toast(L('De Kassa-server is niet bereikbaar.', 'The Kassa server cannot be reached.'));
  },
  language() {
    localStorage.setItem(`${KEY}-lang`, L('en', 'nl'));
    location.reload();
  },
  back() {
    tapped = true;
    if (history.length > 1) history.back();
    else location.hash = '#/';
  },

  // the bank side
  upload: () => $('bankFiles').click(),
  tx: (card, button) => askTx(bank.txs.find((tx) => tx.id === button.dataset.id)),
  sortParty: (card, button) => askTx(bank.txs.find((tx) => tx.id === button.dataset.id)),
  addCat: () => editCat(),
  editCat: (card, button) => editCat(catById(button.dataset.id)),
  deleteCat: (card, button) => closeDialog(button.closest('dialog'), 'delete'),
  async renameAccount(card, button) {
    const account = accountById(button.dataset.id);
    const name = await askText(L('Naam van de rekening', 'Name of the account'), `${account.bank} ${account.id.slice(-4)}`, account.name);
    if (name === null) return;
    account.name = name;
    saveBank();
  },
  // one sheet after the other for the gift card payments that do not say yet what they bought; cancelling stops
  async fillGifts() {
    const open = giftsToFill(bank);
    for (const [index, tx] of open.entries()) {
      const gift = await pickGift(tx, undefined, open.length - index - 1);
      if (!gift) return;
      tx.gift = gift;
      saveBank();
    }
  },
  // a shop's balance
  async startBalance(card, button) {
    const shop = button.dataset.id;
    const cents = await askAmount(L(`Saldo bij ${shop}`, `Balance at ${shop}`), L('Saldo nu', 'Balance now'));
    if (cents === null) return;
    const account = addBalance(bank, { shop, balance: cents, through: isoDate() }, new Date().toISOString());
    saveBank();
    if (account) go(`#/saldo/${account.id}`);
  },
  addPayment: (card, button) => askPayment(accountById(button.dataset.id)),
  deleteTx: (card, button) => closeDialog(button.closest('dialog'), 'delete'),
  async correctBalance(card, button) {
    const account = accountById(button.dataset.id);
    const before = balanceOn(bank, account);
    const now = await askAmount(L('Saldo corrigeren', 'Correct balance'), L('Saldo nu', 'Balance now'));
    if (now === null || now === before) return;
    // the difference is booked as a payment of today (or as money back), so nothing that was spent goes missing
    payFrom(bank, account, isoDate(), now - before, account.shop);
    Object.assign(account, { balance: now, through: isoDate() });
    saveBank();
  },
  async stopMonthly(card, button) {
    const account = accountById(button.dataset.id);
    const each = account.monthly[Number(button.dataset.index)];
    const sure = await ask(L(`${each.name} niet meer elke maand boeken? Wat al geboekt is, blijft staan.`,
      `Stop booking ${each.name} every month? What was booked already stays.`), L('Stoppen', 'Stop'));
    if (!sure) return;
    account.monthly = account.monthly.filter((other) => other !== each);
    saveBank();
  },
  async removeBalance(card, button) {
    const account = accountById(button.dataset.id);
    const sure = await ask(L(`Het saldo bij ${account.shop} niet meer bijhouden? De betalingen uit dit saldo verdwijnen, en een kaart voor deze winkel telt weer als uitgave op de dag van aankoop.`,
      `Stop keeping the balance at ${account.shop}? The payments from this balance are removed, and a card for this shop counts as spending again on the day it is bought.`),
    L('Niet meer bijhouden', 'Stop keeping it'));
    if (!sure) return;
    bank.accounts = bank.accounts.filter((other) => other !== account);
    bank.txs = bank.txs.filter((tx) => tx.acc !== account.id);
    saveBank();
    actions.back();
  },
  fixedYes(card, button) { bank.fixed[button.dataset.id] = true; saveBank(); },
  fixedNo(card, button) { bank.fixed[button.dataset.id] = false; saveBank(); },
  // which month (or year) the pots, a category, the fixed costs and the insight screen show
  monthStep(card, button) {
    const by = Number(button.dataset.by) * (route() === 'inzicht' && view.unit === 'year' ? 12 : 1);
    const month = shiftMonth(view.month, by);
    view.month = month > thisMonth() ? thisMonth() : month;
    redraw(`[data-by="${button.dataset.by}"]`);
  },
  pickMonth(card, button) {
    Object.assign(view, { month: button.dataset.id, unit: 'month' });
    redraw('.column[aria-pressed="true"]');
  },
  unit(card, button) {
    view.unit = button.dataset.id;
    redraw(`[data-action="unit"][data-id="${view.unit}"]`);
  },
  pickWorth(card, button) {
    view.worth = button.dataset.id;
    redraw('.hit[aria-pressed="true"]');
  },
  moreRows() {
    view.rows += 100;
    render();
  },

  // one step of a payment: the till emptied this card, it was skipped, or the last step is taken back
  payNext() { paying.steps.push(true); slide('push', show); },
  paySkip() { paying.steps.push(false); slide('push', show); },
  payBack() { paying.steps.pop(); slide('pop', show); },
  // Klaar on a card means that card was the last one used; after the last card it means all of them were
  payDone: () => finishPayment(payCard() ? [...emptiedCards(), payCard()] : emptiedCards()),
  payFrom(card) {
    paying = { queue: [card.id, ...useOrder().filter((id) => id !== card.id)], steps: [] };
    go('#/betalen');
  },

  editPurchase: () => editPurchase(currentPurchase()),
  who: () => askWho(currentPurchase()),
  async deletePurchase() {
    const purchase = currentPurchase();
    const amount = formatEuro(purchase.total);
    const store = shown(purchase.store);
    const sure = await ask(
      L(`Uitgave van ${amount} bij ${store} verwijderen?${purchase.cards ? ' De gebruikte kaarten krijgen hun saldo terug.' : ''}`,
        `Delete the purchase of ${amount} at ${store}?${purchase.cards ? ' The cards used get their balance back.' : ''}`),
      L('Verwijderen', 'Delete'),
    );
    if (!sure) return;
    state.purchases = state.purchases.filter((each) => each !== purchase);
    for (const card of state.cards) card.entries = card.entries.filter((entry) => entry.purchase !== purchase.id);
    save();
    go('#/uitgaven');
  },

  // the statistics screen: week, month or year, and which one
  statUnit(card, button) {
    const { unit } = button.dataset;
    stats = { unit, start: periodStart(unit, new Date()) };
    redraw(`[data-unit="${unit}"]`);
  },
  statStep(card, button) {
    stats.start = shiftPeriod(stats.unit, stats.start, Number(button.dataset.by));
    redraw(`[data-by="${button.dataset.by}"]`);
  },
  statPick(card, button) {
    stats.start = new Date(Number(button.dataset.id));
    redraw('.column[aria-pressed="true"]');
  },

  check(card) {
    // copy first: the checker opens over the app and asks for this number
    navigator.clipboard?.writeText(card.number).then(() => toast(L('Kaartnummer gekopieerd.', 'Card number copied.')), () => {});
    window.open(CHECKER, '_blank', 'noopener');
  },

  async correct(card) {
    const now = await askAmount(L('Saldo corrigeren', 'Correct balance'), L('Nieuw saldo', 'New balance'));
    if (now === null || now === balance(card)) return;
    card.entries.push(newEntry('correct', now - balance(card)));
    save();
  },

  async delete(card) {
    const sure = await ask(
      L(`Kaart ${last4(card)} met ${formatEuro(balance(card))} verwijderen? Dit kan niet ongedaan worden gemaakt.`,
        `Delete card ${last4(card)} with ${formatEuro(balance(card))}? This cannot be undone.`),
      L('Verwijderen', 'Delete'),
    );
    if (!sure) return;
    state.cards = state.cards.filter((other) => other !== card);
    save();
    goCards();
  },

  async undo(card, button) {
    const gone = card.entries.find((entry) => entry.id === button.dataset.entry);
    const after = balance(card) - gone.delta;
    if (after < 0) {
      toast(L('Dit kan niet: het saldo zou onder nul komen.', 'Not possible: the balance would drop below zero.'));
      return;
    }
    const sure = await ask(
      `${removeEntryText(gone)}? ${L('Het saldo wordt', 'The balance becomes')} ${formatEuro(after)}.`,
      L('Verwijderen', 'Delete'),
    );
    if (!sure) return;
    card.entries = card.entries.filter((entry) => entry !== gone);
    save();
  },
};

document.addEventListener('click', (event) => {
  if (event.target.closest('a[href^="#/"]')) tapped = true;
  if (event.target.matches('.action-sheet')) closeDialog(event.target); // a tap on the dimmed area cancels
  const target = event.target.closest('[data-action]');
  if (target) actions[target.dataset.action](currentCard(), target);
});
$('importFile').addEventListener('change', importBackup);
$('bankFiles').addEventListener('change', importBankFiles);
// the search field and the pick lists of the transactions screen redraw only the list, so the keyboard stays up
document.addEventListener('input', (event) => {
  if (event.target.id !== 'txSearch') return;
  Object.assign(view, { query: event.target.value, rows: 60 });
  $('txList').innerHTML = txList();
});
document.addEventListener('change', (event) => {
  const { filter } = event.target.dataset;
  if (filter) {
    Object.assign(view, { [filter]: event.target.value, rows: 60 });
    $('txList').innerHTML = txList();
  }
  if (event.target.id === 'sinceInput' && (event.target.value === '' || isDate(event.target.value))) {
    bank.since = event.target.value;
    saveBank();
  }
});
// the months of the line chart are drawn, not buttons: give them the keys a button has
document.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key) || !event.target.matches?.('svg [role="button"]')) return;
  event.preventDefault();
  actions[event.target.dataset.action](undefined, event.target);
});

addEventListener('hashchange', () => {
  view.rows = 60;
  const next = depth();
  const nav = next > shownDepth ? 'push' : next < shownDepth ? 'pop' : '';
  // slide only after a tap in the app: the iPhone back gesture brings its own animation
  if (tapped && nav) slide(nav, show);
  else show();
  tapped = false;
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
// The iPhone keyboard can slide the visible area down past a sheet's fields (it scrolls to a field that
// was still below the screen while the sheet rose); style.css moves the sheets along by this much.
const pan = () => document.documentElement.style.setProperty('--pan', `${visualViewport.offsetTop}px`);
visualViewport?.addEventListener('scroll', pan);
visualViewport?.addEventListener('resize', pan);

// index.html is written in Dutch; data-en holds an element's English text, or an input's English placeholder
document.documentElement.lang = lang;
if (lang === 'en') {
  for (const element of document.querySelectorAll('[data-en]')) element[element.matches('input') ? 'placeholder' : 'textContent'] = element.dataset.en;
}

navigator.storage?.persist?.(); // ask the browser not to evict the cards
navigator.serviceWorker?.register('sw.js');
state = load();
bank = loadBank();
if (catchUp(bank, isoDate()).length) saveBank();
else render();
sync();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (catchUp(bank, isoDate()).length) saveBank();
  sync(); // what the other phone changed meanwhile
});
addEventListener('online', () => sync());
setInterval(() => document.hidden || sync(), 10_000); // while Kassa is on screen: the other phone's changes show up within seconds
