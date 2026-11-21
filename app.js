import {
  balance, cleanDigits, code128, daysLeft, expiryState, formatEuro as euroIn, groupNumber, isDate, isName, isoDate, isoWeek,
  needsInstall, parseEuro, parseState, periodStart, settle, shareOut, shiftPeriod, sortCards, summarize,
  validCode, validNumber,
} from './logic.js';

const KEY = 'ah-saldo'; // the app's first name; changing this key would hide everything already saved
// Dutch unless English was chosen on this phone. L(dutch, english) picks the text; switching reloads the app.
const lang = localStorage.getItem(`${KEY}-lang`) === 'en' ? 'en' : 'nl';
const L = (nl, en) => (lang === 'en' ? en : nl);
const LOCALE = L('nl-NL', 'en-GB');
const formatEuro = (cents) => euroIn(cents, LOCALE);
// AH's official "Saldochecker AH cadeaukaart" link, as published on ah.nl
const CHECKER = 'https://service2.loyaltyinabox.com/CardBalanceChecker/2/paymentapi.aspx?cmd=showbalance&username=1379001&lang=nl-NL';
const KIND = { start: L('Beginsaldo', 'Starting balance'), pay: L('Betaling', 'Payment'), correct: L('Correctie', 'Correction') };
const US = 'Wij'; // who a purchase is for until someone else is chosen
const SHOPS = ['AH', 'Plus', 'Jumbo', 'Dirk', 'Lidl', 'Anders'];
// the default names are saved in Dutch, so a language switch leaves the data alone
const ENGLISH_NAMES = new Map([[US, 'Us'], ['Anders', 'Other']]);
const shown = (name) => (lang === 'en' && ENGLISH_NAMES.get(name)) || name;
const UNITS = { week: 'Week', month: L('Maand', 'Month'), year: L('Jaar', 'Year') };
const SPAN = { week: 8, month: 6, year: 4 }; // how many periods the chart shows

const $ = (id) => document.getElementById(id);
const app = $('app');
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let state;

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

const cardById = (id) => state.cards.find((card) => card.id === id);
const purchaseById = (id) => state.purchases.find((purchase) => purchase.id === id);
// the defaults first, then what has been used so far, most recent first
const listed = (defaults, used) => [...new Set([...defaults, ...used.reverse()])];
const people = () => listed([US], state.purchases.flatMap((purchase) => purchase.shares.map((share) => share.who)));
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

// ---------- home, card, archive ----------

function homeScreen() {
  const active = sortCards(state.cards.filter((card) => balance(card) > 0));
  const spent = state.cards.length - active.length;
  const total = active.reduce((sum, card) => sum + balance(card), 0);
  const month = periodStart('month', new Date());
  const thisMonth = summarize(state.purchases, month, shiftPeriod('month', month, 1)).total;
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
        <h1>Kassa</h1>
        <button class="round" data-action="add" aria-label="${L('Kaart toevoegen', 'Add card')}">${icon('plus')}</button>
      </header>
      <section class="summary">
        <p class="footnote">${L('Totaal saldo', 'Total balance')}</p>
        <p class="total">${formatEuro(total)}</p>
        <p class="footnote">${L(plural(active.length, 'kaart', 'kaarten'), plural(active.length, 'card', 'cards'))}</p>
      </section>
      ${state.needsBackup ? `
        <div class="group">
          <p class="row notice">${icon('warn')}<span class="row-main">${L('Je hebt nieuwe kaarten zonder back&#8209;up.', 'You have new cards without a backup.')}</span></p>
          <button class="row tint" data-action="export">${L('Back-up maken', 'Make a backup')}</button>
        </div>` : ''}
      <h2 class="section">${L('Kaarten', 'Cards')}</h2>
      ${active.length
        ? `<ul class="passes">${passes}</ul>`
        : blank(L('Nog geen kaarten', 'No cards yet'), L('Voeg je eerste AH cadeaukaart toe.', 'Add your first AH gift card.'))}
      <div class="group">
        <a class="row" href="#/uitgaven">
          <span class="row-main">${L('Uitgaven <small>Deze maand</small>', 'Spending <small>This month</small>')}</span> ${formatEuro(thisMonth)}${icon('next')}</a>
        ${spent ? `<a class="row" href="#/archief"><span class="row-main">${L('Lege kaarten', 'Empty cards')}</span> ${spent}${icon('next')}</a>` : ''}
      </div>
      <h2 class="section">${L('Back-up', 'Backup')}</h2>
      <div class="group">
        <button class="row tint" data-action="export">${L('Back-up maken', 'Make a backup')}</button>
        <button class="row tint" data-action="import">${L('Terugzetten', 'Restore')}</button>
      </div>
      <p class="group-note">${L(`Je kaarten staan alleen op deze telefoon. Het back&#8209;upbestand bevat alle nummers
        en codes: bewaar het als contant geld.`, `Your cards are only on this phone. The backup file holds every number
        and code: keep it as safe as cash.`)}</p>
      <h2 class="section">${L('Taal', 'Language')}</h2>
      <div class="group">
        ${L('<button class="row tint" data-action="language" lang="en">Use English</button>',
          '<button class="row tint" data-action="language" lang="nl">Nederlands gebruiken</button>')}
      </div>`,
    // paying with gift cards is the thumb button; a purchase paid another way sits beside it
    dock: `
      <button class="button" data-action="addPurchase">${icon('plus')}${L('Uitgave', 'Purchase')}</button>
      ${active.length
        ? `<a class="button primary" href="#/betalen">${L('Betalen', 'Pay')}</a>`
        : `<button class="button primary" data-action="add">${L('Kaart toevoegen', 'Add card')}</button>`}`,
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
        <a class="back" href="${left > 0 ? '#/' : '#/archief'}">${icon('back')}${left > 0 ? L('Kaarten', 'Cards') : L('Lege kaarten', 'Empty cards')}</a>
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
        <a class="back" href="#/">${icon('back')}${L('Kaarten', 'Cards')}</a>
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
    : `<a class="back" href="#/">${icon('back')}${L('Kaarten', 'Cards')}</a>`;
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
  goHome();
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

// Columns for the last few periods: the chosen one in blue, the others grey. A tap on a column chooses it.
function trendChart(unit, chosen) {
  const now = periodStart(unit, new Date());
  // the chart ends at the current period, unless an older one is chosen: then it ends there
  const end = chosen < shiftPeriod(unit, now, 1 - SPAN[unit]) ? chosen : now;
  const periods = Array.from({ length: SPAN[unit] }, (unused, index) => {
    const start = shiftPeriod(unit, end, index + 1 - SPAN[unit]);
    return { start, total: summarize(state.purchases, start, shiftPeriod(unit, start, 1)).total };
  });
  const most = Math.max(...periods.map((period) => period.total));
  return periods.map(({ start, total }) => {
    const height = most ? Math.max(Math.round(total / most * 88), total ? 2 : 0) : 0; // of a 92 unit tall plot
    // rounded at the top, square on the baseline; too short to round below 8
    const shape = height >= 8 ? `<path d="M0 92V${96 - height}a4 4 0 0 1 4-4h16a4 4 0 0 1 4 4V92z"/>`
      : `<rect y="${92 - height}" width="24" height="${height}"/>`;
    const label = `${periodName(unit, start)}: ${formatEuro(total)}`;
    return `
      <li><button class="column" data-action="statPick" data-start="${start.getTime()}"
        aria-pressed="${start.getTime() === chosen.getTime()}" aria-label="${label}" title="${label}">
        <svg viewBox="0 0 24 92" aria-hidden="true">${shape}</svg>
        <span>${periodShort(unit, start)}</span>
      </button></li>`;
  }).join('');
}

// One row per person or shop: name, amount, share, and a bar for that share of the period.
const meters = (pairs, total) => pairs.map(([name, cents]) => `
  <li class="row meter-row">
    <span class="row-main">${esc(shown(name))}</span>
    <span>${formatEuro(cents)} <small>${Math.round(cents / total * 100)}%</small></span>
    <svg class="meter" aria-hidden="true"><rect class="track" width="100%" height="100%" rx="4"/>
      <rect width="${(cents / total * 100).toFixed(1)}%" height="100%" rx="4"/></svg>
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
        <a class="back" href="#/">${icon('back')}${L('Kaarten', 'Cards')}</a>
        <h1>${L('Uitgaven', 'Spending')}</h1>
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
        <ul class="columns">${trendChart(unit, start)}</ul>
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
      : blank(L('Geen uitgaven', 'No spending'), L('In deze periode is niets vastgelegd.', 'Nothing was recorded in this period.'))}`,
    dock: `<button class="button primary" data-action="addPurchase">${L('Uitgave toevoegen', 'Add purchase')}</button>`,
  };
}

function purchaseScreen(purchase) {
  const day = new Date(purchase.at).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return {
    html: `
      <header class="navbar">
        <a class="back" href="#/uitgaven">${icon('back')}${L('Uitgaven', 'Spending')}</a>
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

const route = () => location.hash.split('/')[1]; // "#/kaart/<id>" -> "kaart"
const routeId = () => location.hash.split('/')[2];
const currentCard = () => (route() === 'kaart' ? cardById(routeId()) : undefined);
const currentPurchase = () => (route() === 'uitgave' ? purchaseById(routeId()) : undefined);

// how deep the current address sits, which decides whether a change slides forward or back
const DEPTH = { archief: 1, uitgaven: 1, kaart: 2, uitgave: 2, betalen: 3 };
const depth = () => DEPTH[route()] ?? 0;
let shownDepth = 0;
let tapped = false; // true when a tap inside the app caused the navigation

function render() {
  const card = currentCard();
  const purchase = currentPurchase();
  // a payment lives only while its screen is open; it starts with the cards in the order to use them
  if (route() !== 'betalen') paying = null;
  else paying ??= { queue: useOrder(), steps: [] };
  const atTill = Boolean(card || paying?.queue.length); // the screens a till scanner reads stay white
  const screen = needsInstall(navigator.userAgent, standalone) ? installScreen()
    : card ? cardScreen(card)
    : atTill ? payScreen()
    : purchase ? purchaseScreen(purchase)
    : ['uitgaven', 'uitgave'].includes(route()) ? statsScreen()
    : route() === 'archief' ? archiveScreen()
    : homeScreen();
  document.body.classList.toggle('pay', atTill);
  app.innerHTML = screen.html;
  $('dock').innerHTML = screen.dock ?? '';
  $('dock').hidden = !screen.dock;
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

function goHome() {
  tapped = depth() > 0;
  location.hash = '#/';
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

async function ask(text, okLabel) {
  $('confirmText').textContent = text;
  $('confirmOk').textContent = okLabel;
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

// Asks who a purchase was for and saves the answer. One name takes everything; with Verdelen on, the
// other names get the amounts typed behind them and the chosen name gets what is left.
async function askWho(purchase) {
  const form = $('whoDialog').querySelector('form');
  const main = purchase.shares[0].who; // shares are kept largest first
  const part = (who) => (who === main ? '' : euroInput(purchase.shares.find((share) => share.who === who)?.cents ?? 0)).replace(/^0[,.]00$/, '');
  const choice = (who, name) => `
    <label class="row choice">
      <input type="radio" name="who" value="${esc(who)}"${who === main ? ' checked autofocus' : ''}>
      ${name}${icon('check')}
      <input class="part" data-who="${esc(who)}" inputmode="decimal" autocomplete="off" placeholder="${L('0,00', '0.00')}"
        value="${part(who)}" aria-label="${L('Bedrag voor', 'Amount for')} ${esc(shown(who)) || L('de andere naam', 'the other name')}">
    </label>`;
  $('whoNote').textContent = `${formatEuro(purchase.total)} ${L('bij', 'at')} ${shown(purchase.store)}`;
  const otherName = L('Andere naam', 'Other name');
  $('whoNames').innerHTML = people().map((who) => choice(who, `<span class="row-main">${esc(shown(who))}</span>`)).join('')
    + choice('', `<input class="row-main" name="other" maxlength="30" autocomplete="off" placeholder="${otherName}" aria-label="${otherName}">`);
  form.elements.split.checked = purchase.shares.length > 1;
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
    shares = shareOut(purchase.total, chosen, parts);
    return shares === 'over' ? L(`Dat is samen meer dan ${formatEuro(purchase.total)}.`, `That adds up to more than ${formatEuro(purchase.total)}.`) : '';
  });
  if (answer !== 'ok') return;
  purchase.shares = shares;
  save();
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

// Adds a purchase paid without gift cards, or edits `purchase` when given.
async function editPurchase(purchase) {
  const form = $('purchaseDialog').querySelector('form');
  const field = form.elements;
  form.reset();
  $('purchaseTitle').textContent = purchase ? L('Uitgave bewerken', 'Edit purchase') : L('Uitgave toevoegen', 'Add purchase');
  // a purchase saved with a shop from before this list keeps that shop
  const choices = purchase && !SHOPS.includes(purchase.store) ? [...SHOPS, purchase.store] : SHOPS;
  field.store.innerHTML = choices.map((shop) => `<option value="${esc(shop)}">${esc(shown(shop))}</option>`).join('');
  // a new purchase starts with the shop of the last one that was paid without cards
  field.store.value = purchase?.store ?? state.purchases.findLast((each) => !each.cards && SHOPS.includes(each.store))?.store ?? SHOPS[0];
  const before = isoDate(new Date(purchase?.at ?? Date.now()));
  field.total.value = purchase ? euroInput(purchase.total) : '';
  field.date.value = before;
  let next;
  const answer = await openDialog($('purchaseDialog'), () => {
    next = { store: field.store.value.trim(), total: parseEuro(field.total.value), date: field.date.value };
    if (!isName(next.store)) return L('Kies de winkel.', 'Choose the shop.');
    if (!next.total) return L('Vul het bedrag in, bijvoorbeeld 25,00.', 'Enter the amount, for example 25.00.');
    if (purchase && next.total < purchase.cards) {
      return L(`Minstens ${formatEuro(purchase.cards)}: zoveel is met cadeaukaarten betaald.`,
        `At least ${formatEuro(purchase.cards)}: that much was paid with gift cards.`);
    }
    if (!isDate(next.date)) return ENTER_DATE;
    return '';
  });
  if (answer !== 'ok') return;
  // the time of day is kept unless the date changed; another day counts as noon that day
  const at = next.date === before ? purchase?.at ?? new Date().toISOString() : new Date(`${next.date}T12:00`).toISOString();
  if (!purchase) {
    const added = { ...newPurchase(next.store, next.total, 0), at };
    state.purchases.push(added);
    save();
    askWho(added);
    return;
  }
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
  const json = JSON.stringify({ app: 'kassa', version: 1, exportedAt: new Date().toISOString(), cards, purchases }, null, 2);
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
  try {
    next = parseState(await file.text());
  } catch {
    toast(L('Dit is geen geldige back-up van Kassa.', 'This is not a valid Kassa backup.'));
    return;
  }
  const sure = await ask(
    L(`Back-up met ${next.cards.length} kaarten terugzetten? Dit vervangt de ${state.cards.length} kaarten en alle uitgaven die nu in de app staan.`,
      `Restore the backup with ${next.cards.length} cards? This replaces the ${state.cards.length} cards and all purchases now in the app.`),
    L('Terugzetten', 'Restore'),
  );
  if (!sure) return;
  state = { ...next, needsBackup: false };
  save();
  goHome();
}

// Each action gets the card of the current screen (if any) and the element that was tapped.
const actions = {
  add: () => editCard(),
  edit: (card) => editCard(card),
  close: (card, button) => closeDialog(button.closest('dialog')),
  export: exportBackup,
  import: () => $('importFile').click(),
  language() {
    localStorage.setItem(`${KEY}-lang`, L('en', 'nl'));
    location.reload();
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

  addPurchase: () => editPurchase(),
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
    stats.start = new Date(Number(button.dataset.start));
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
    goHome();
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

addEventListener('hashchange', () => {
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
render();
