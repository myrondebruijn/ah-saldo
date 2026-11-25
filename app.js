import {
  addCards, balance, cleanDigits, code128, daysLeft, expiryState, formatEuro as euroIn, groupNumber, isDate, isName, isoDate, isoWeek,
  needsInstall, parseBig, parseEuro, parseState, periodStart, settle, shareOut, shiftPeriod, sortCards, summarize,
  validCode, validNumber,
} from './logic.js';
import {
  AH, LARGE, START_CATS, US, addBalance, addFile, addStarter, balanceOn, byParty, cardsOn, cardsToAdd, catchUp, decodeText, dayRate, dueOn, emptyBank, ended, figures, fixedCosts,
  fixedSuggestions, forWhom, giftGuesses, giftsBought, giftsToFill, hasGap, heldShops, inCategory, monthOf, onBalance, parseBank, payFrom, plannedOpen, potsLeft, readCsv, salaryBase,
  addLinked, bought, deposits, goalMonths, salaryToCome, holdings, invested, isGoal, isTrade, monthsFrom, readLinked, readPdf, ruleKey, sellsCards, shiftMonth, sortAll, sorter, strayDeposits, tie,
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
  ['Overboeking', 'Transfer'], ['Beleggen', 'Investing'], ['Werk & bedrijf', 'Work & business'], ['Aflossing lening', 'Loan repayment'],
  ['Creditcard (Amex)', 'Credit card (Amex)'],
]);
const shown = (name) => (lang === 'en' && ENGLISH_NAMES.get(name)) || name;
const UNITS = { week: 'Week', month: L('Maand', 'Month'), year: L('Jaar', 'Year') };
const SPAN = { week: 8, month: 6, year: 4 }; // how many periods the chart shows
const STALE = 30; // days after which the overview asks for new bank files
// Raise by one when the saved data gains something an older Kassa would drop while saving: the server then lets an
// older Kassa read but not write (worker/index.js, PUT /vault), until that phone has the new one.
// 2: the phones keep no copy; an older Kassa, which syncs a copy it keeps, may not write any more
// 3: a card knows the payment that bought it, a till payment the bank line of its pin part
// 4: a payment keeps what gift card it bought in any category; an older Kassa took that off when it was sorted elsewhere
const DATA = 5; // 5: a savings goal
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

// Without sharing the phone keeps the data; with sharing the server holds the only copy (see sync).
function store(key, value) {
  if (!sharing) localStorage.setItem(key, JSON.stringify(value));
}

// Every save first ties what belongs together (bank.js, tie): a new bank line to the till payment that waits for
// it, a new card to the payment that bought it.
function save() {
  tie(bank, state);
  try {
    store(KEY, state);
  } catch {
    toast(L('Opslaan is mislukt. Maak nu een back-up.', 'Saving failed. Make a backup now.'));
  }
  render();
  sync();
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
    if (tie(bank, state)) store(KEY, state);
    store(BANK_KEY, bank);
  } catch {
    toast(L('Opslaan is mislukt: de opslag van de telefoon is vol.', 'Saving failed: the storage of the phone is full.'));
  }
  render();
  sync();
  reportMonth();
}

// ---------- sharing ----------
// With sharing on, the cards and bank data are on the Kassa server only, locked (see sync.js): the phone keeps no
// copy, as a copy an older Kassa had read once wiped what the other phone entered (23 November 2026). Kassa fetches
// everything when it opens, when it comes back to the front and every ten seconds while it is on screen; every change
// goes to the server at once, and one the server did not take is undone on the screen too.

const SHARE_KEY = `${KEY}-sync`; // { key: the household key, cred: this phone's passkey, version: of the data on screen }
let sharing = readSharing();
if (sharing) sharing.version = 0; // nothing is kept on the phone: fetch it all
let household = sharing && fromB64u(sharing.key);
let onServer = null; // the data as the server has it (canonical JSON), null until it is in
let syncing = false;
let syncAgain = false;
let syncError = null;
// the copies an earlier Kassa kept on the phone
const forgetLocal = () => [KEY, BANK_KEY, `${KEY}-sync-base`].forEach((key) => localStorage.removeItem(key));

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
  onServer = base;
}

// Puts `data` (canonical) in the app in place of what was there.
function takeData(data) {
  ({ state, bank } = data);
}

// A sheet is open or a field has the keyboard: replacing the data now would undo what is being entered.
const busy = () => Boolean(document.querySelector('dialog[open]'))
  || (app.contains(document.activeElement) && document.activeElement.matches('input, select, textarea'));

// Brings the screen and the server level: fetches what is new there, joins it with the change just made here (when
// the other phone saved in the same moment), and sends that. One run at a time; a call during a run makes it run once more.
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
      const first = !onServer;
      takeData(first || mine === onServer ? theirs : canonical(merge(JSON.parse(onServer), JSON.parse(mine), theirs)));
      sharing.version = remote.version;
      keepSharing(JSON.stringify(theirs));
      if (first) {
        catchUp(bank, isoDate()); // the bookings of the shop balances since the last opening; they go up below
        tie(bank, state); // and what an earlier Kassa left untied
      }
      changed = true;
    }
    const now = snapshot();
    if (onServer && now !== onServer) { // never before the data is in: an empty app would replace it
      const me = localStorage.getItem(PUSH_KEY) ?? undefined; // so the server does not tell this phone what it changed itself
      const sent = await api('PUT', '/vault', { token, body: { base: sharing.version, data: await sealData(household, now), me, app: DATA } })
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
    if (onServer && snapshot() !== onServer) { // not on the server, so not kept: the screen shows what is there
      takeData(JSON.parse(onServer));
      changed = true;
      toast(error.status === 426 ? L('Niet opgeslagen: deze Kassa is verouderd. Sluit Kassa en open hem opnieuw.', 'Not saved: this Kassa is out of date. Close Kassa and open it again.')
        : error.status === 401 ? L('Niet opgeslagen: deze telefoon wordt niet meer toegelaten.', 'Not saved: this phone is no longer let in.')
          : L('Niet opgeslagen: geen verbinding met de Kassa-server. Probeer het opnieuw als je verbinding hebt.', 'Not saved: no connection with the Kassa server. Try again once you have a connection.'));
    }
  } finally {
    syncing = false;
  }
  // the settings screen says whether the server is reachable; redrawing it every round would close its date picker
  if (changed || ((route() === 'meer' || !onServer) && failed !== Boolean(syncError))) render();
  if (syncAgain && tries > 1) await sync(tries - 1);
}

// Starts sharing on this phone with household key `key`, the data in the app being version `version`.
function link(key, cred, version) {
  household = key;
  sharing = { key: b64u(key), cred, version };
  keepSharing(snapshot());
  forgetLocal();
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
        : error.status === 502 ? L('De bank weigerde dit. Probeer het later opnieuw.', 'The bank refused this. Try again later.')
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

// ---------- bank links ----------
// With sharing on, the Kassa server can fetch the new lines of the linked Rabo, Openbank and Trade Republic accounts itself (see
// worker/index.js). Kassa asks for them when it opens and while it is on screen, at most once an hour per phone. Linking
// goes through the bank's own consent page, which sends the person back to Kassa's address with a one-time code.

const LINKS_KEY = `${KEY}-links`; // on this phone: { banks: { Rabo: until, ... }, at: the last try, ok: the last fetch, failed: banks }
const LINKABLE = { Rabo: 'Rabobank', Openbank: 'Openbank', 'Trade Republic': 'Trade Republic' }; // Kassa's name of a bank -> Enable Banking's
const HOUR = 60 * 60 * 1000;
let links = readLinks();
localStorage.removeItem(`${KEY}-rabo`); // what the first version, for Rabo alone, kept; the next fetch fills the new one

function readLinks() {
  try {
    return { banks: {}, failed: [], ...JSON.parse(localStorage.getItem(LINKS_KEY)) };
  } catch {
    return { banks: {}, failed: [] };
  }
}
const keepLinks = () => localStorage.setItem(LINKS_KEY, JSON.stringify(links));

// `asked`: the Fetch now button, which does not wait for the hour and says how it went
async function fetchBank(asked = false) {
  const announced = await globalThis.caches?.delete('kassa-news'); // a notification came in since (sw.js): don't wait for the hour
  if (!sharing || !onServer || (!asked && !announced && Date.now() - (links.at ?? 0) < HOUR)) return;
  links.at = Date.now(); // a failed try waits an hour too
  keepLinks();
  if (asked) toast(L('Ophalen bij de bank…', 'Fetching from the bank…'));
  // from a week before the newest last line of an account (a linked one: those are fetched most), as the link may date a
  // line a day earlier than the bank's file and what is there already is not added again; Rabo gives at most 90 days.
  const last = bank.accounts.filter((account) => !account.card && !account.shop && account.through).map((account) => account.through).sort().at(-1);
  const from = last ? isoDate(new Date(Math.max(Date.parse(last) - 7 * 24 * HOUR, Date.now() - 89 * 24 * HOUR))) : '';
  try {
    const got = await api('GET', `/bank${from && `?from=${from}`}`, { token: await tokenOf(household) });
    const file = readLinked(got.accounts);
    if (busy()) {
      links.at = 0; // adding now would undo what is being entered: the next round tries again
      return;
    }
    const { added, skipped } = addLinked(bank, file, new Date().toISOString());
    const failed = [...new Set([...got.failed, ...file.accounts.filter((account) => skipped.includes(account.id)).map((account) => account.bank)])];
    links = { ...links, banks: Object.fromEntries(got.links.map((link) => [link.bank, link.until])), ok: Date.now(), failed };
    catchUp(bank, isoDate());
    saveBank();
    const news = added ? L(`${plural(added, 'nieuwe banktransactie', 'nieuwe banktransacties')}.`, `${plural(added, 'new bank transaction', 'new bank transactions')}.`)
      : asked ? L('Niets nieuws van de bank.', 'Nothing new from the bank.') : '';
    const trouble = asked && failed.length ? L(`Ophalen bij ${failed.join(' en ')} lukte niet; probeer het later opnieuw.`, `Fetching from ${failed.join(' and ')} failed; try again later.`) : '';
    if (news || trouble) toast([news, trouble].filter(Boolean).join(' '));
  } catch (error) {
    if (error.status === 404) links = { banks: {}, failed: [], at: links.at }; // nothing is linked
    else links.failed = Object.keys(links.banks);
    if (asked) {
      render();
      if (error.status === 404) toast(L('Er is geen bank gekoppeld.', 'No bank has been linked.'));
      else shareError(error);
    }
  } finally {
    keepLinks();
  }
}

async function linkBank(name) {
  try {
    const { url } = await api('POST', '/bank/start', { token: await tokenOf(household), body: { bank: LINKABLE[name] } });
    location.href = url;
  } catch (error) {
    shareError(error);
  }
}

// Back from the bank: `code` when consent was given. This may open in Safari instead of the Home Screen app; the
// server keeps the link, so it works from either.
async function backFromBank(params) {
  history.replaceState(null, '', location.pathname + location.hash); // the code works once: a reload must not send it again
  if (!params.get('code')) {
    toast(L('De bank is niet gekoppeld.', 'The bank has not been linked.'));
    return;
  }
  try {
    const { bank: name, until } = await api('POST', '/bank/finish', { body: { state: params.get('state'), code: params.get('code') } });
    links.banks[name] = until;
    links.at = 0;
    keepLinks();
    render();
    toast(sharing ? L(`${name} is gekoppeld.`, `${name} is linked.`) : L(`${name} is gekoppeld. Ga terug naar Kassa op je beginscherm.`, `${name} is linked. Go back to Kassa on your Home Screen.`));
    fetchBank();
  } catch (error) {
    if (error.status === 403) toast(L('Deze koppeling is verlopen of al gebruikt. Koppel opnieuw in Instellingen.', 'This link has expired or was used already. Link again in Settings.'));
    else shareError(error);
  }
}

// ---------- share prices ----------
// What the funds on Beleggen are worth: the Kassa server asks for their prices (worker/quotes.js), at most once an
// hour per phone and at once when other funds are held. The prices stay on this phone: they are not shared data.

const QUOTES_KEY = `${KEY}-quotes`; // on this phone: { at: the last try, ids: the funds it was for, ok: the last fetch, prices: { ticker: euros for one } }
let quotes = readQuotes();

function readQuotes() {
  try {
    return { prices: {}, ...JSON.parse(localStorage.getItem(QUOTES_KEY)) };
  } catch {
    return { prices: {} };
  }
}

async function fetchQuotes() {
  const ids = holdings(bank).map((fund) => fund.stock).sort().join(',');
  if (!sharing || !ids || (ids === quotes.ids && Date.now() - (quotes.at ?? 0) < HOUR)) return;
  Object.assign(quotes, { at: Date.now(), ids }); // a failed try waits an hour too
  try {
    const got = await api('GET', `/quotes?s=${encodeURIComponent(ids)}`, { token: await tokenOf(household) });
    // a share that got no price this time keeps the last one it had
    quotes = { ...quotes, ok: Date.now(), prices: { ...quotes.prices, ...Object.fromEntries(Object.entries(got).filter(([, euros]) => euros > 0)) } };
    if (['', 'beleggen', 'inzicht'].includes(route())) render(); // the screens that show them; elsewhere a redraw would only disturb
  } catch { /* the last prices stay */ }
  localStorage.setItem(QUOTES_KEY, JSON.stringify(quotes));
}

// ---------- notifications ----------
// Web Push from the Kassa server (worker/index.js says when). iOS shows them only for Kassa on the Home Screen, and
// asks permission only straight from a tap, so the server's key is fetched ahead.

const PUSH_KEY = `${KEY}-push`; // this phone's id at the server while notifications are on
const PUSH_LATER = `${KEY}-push-later`; // "Niet nu" on the question on Overview; the switch in Settings stays
let pushKey = '';

async function sendSubscription(subscription) {
  const { endpoint, keys } = subscription.toJSON();
  const { id } = await api('PUT', '/push', { token: await tokenOf(household), body: { endpoint, p256dh: keys.p256dh, auth: keys.auth, lang } });
  localStorage.setItem(PUSH_KEY, id);
}

async function pushOn() {
  try {
    if (!pushKey) throw said(L('Geen verbinding met de Kassa-server. Probeer het later opnieuw.', 'No connection with the Kassa server. Try again later.'));
    const registration = await navigator.serviceWorker.ready;
    await sendSubscription(await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(pushKey) }));
    render();
    toast(L('Meldingen staan aan.', 'Notifications are on.'));
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      toast(L('Meldingen zijn niet toegestaan. Zet ze aan in de iPhone-instellingen bij Meldingen, Kassa.', 'Notifications are not allowed. Turn them on in the iPhone settings under Notifications, Kassa.'));
    } else shareError(error);
  }
}

async function pushOff() {
  const id = localStorage.getItem(PUSH_KEY);
  localStorage.removeItem(PUSH_KEY);
  render();
  toast(L('Meldingen staan uit.', 'Notifications are off.'));
  await navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription()).then((subscription) => subscription?.unsubscribe()).catch(() => {});
  if (id) await api('DELETE', `/push/${id}`, { token: await tokenOf(household) }).catch(() => {}); // else the server forgets it at the next message
}

// At start: the key ahead of a tap, and this phone's subscription once more, which also brings a changed language.
async function startPush() {
  if (!sharing || !('PushManager' in window)) return;
  try {
    pushKey = (await api('GET', '/push', { token: await tokenOf(household) })).key;
    if (!localStorage.getItem(PUSH_KEY)) {
      if (!busy()) render(); // Overview can ask now
      return;
    }
    const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (subscription) await sendSubscription(subscription);
    else localStorage.removeItem(PUSH_KEY); // turned off in the iPhone settings
  } catch { /* offline: the next start tries again */ }
}

// ---------- closing a month ----------
// Last month is closed once every bank account has news from after it: a line booked, or a file read or fetched,
// after its last day. An account with nothing on it (balance 0, no lines that month) does not count. Each phone tells
// the server how far it got; the server announces a closed month once, and reminds while it is not.

const MONTH_KEY = `${KEY}-month`; // what this phone told the server last

// the bank accounts that keep last month from being closed
function missingFiles() {
  const month = shiftMonth(thisMonth(), -1);
  const next = `${thisMonth()}-01`;
  return bank.accounts.filter((account) => !account.shop && account.through < next && isoDate(new Date(account.uploaded)) < next
    && !(account.balance === 0 && !bank.txs.some((tx) => tx.acc === account.id && monthOf(tx.date) === month)));
}

function reportMonth() {
  if (!sharing || !bank.accounts.length) return;
  const month = shiftMonth(thisMonth(), -1);
  const missing = missingFiles().map((account) => account.name.slice(0, 40));
  const told = JSON.stringify({ month, missing });
  if (localStorage.getItem(MONTH_KEY) === told) return;
  const { spending, income, open } = monthFigures(month);
  tokenOf(household).then((token) => api('POST', '/month', { token, body: { month, missing, spending, income, open } }))
    .then(() => localStorage.setItem(MONTH_KEY, told), () => {}); // not sent: the next save tries again
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
const monthLong = (month) => monthDate(month).toLocaleDateString(LOCALE, { month: 'long' });
const dayBefore = (date) => new Date(Date.parse(date) - 864e5).toISOString().slice(0, 10);
const dayShort = (day) => new Date(day).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');
// when something was last fetched: the time when that was today, else the day
const clockText = (time) => (isoDate(new Date(time)) === isoDate()
  ? `${L('om', 'at')} ${new Date(time).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}`
  : `${L('op', 'on')} ${dayShort(isoDate(new Date(time)))}`);
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
// `worth` is a month tapped on the net worth line; '' follows the month on screen. `goal`: a month tapped on the goal's bars.
const view = { month: thisMonth(), unit: 'month', worth: '', query: '', cat: 'all', acc: 'all', rows: 60, goal: '' };

const cardById = (id) => state.cards.find((card) => card.id === id);
const purchaseById = (id) => state.purchases.find((purchase) => purchase.id === id);
// the defaults first, then what has been used so far, most recent first
const listed = (defaults, used) => [...new Set([...defaults, ...used.reverse()])];
const people = () => listed([US], [...state.purchases, ...bank.txs].flatMap((each) => (each.shares ?? []).map((share) => share.who)));
const whoText = (purchase) => purchase.shares.map((share) => shown(share.who)).join(', ');
// the till payment a bank line is the pin part of, while that line is groceries (bank.js, tie)
const tillOf = (tx, cat) => (cat === 'boodschappen' ? state.purchases.find((purchase) => purchase.tx === tx.id) : undefined);
const dayOf = (purchase) => isoDate(new Date(purchase.at));

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
// Overview asks once per phone. The answer must be a tap of its own: only straight from one does iOS ask for permission.
const pushNotice = () => (pushKey && standalone && Notification.permission !== 'denied' && !localStorage.getItem(PUSH_KEY) && !localStorage.getItem(PUSH_LATER) ? `
  <div class="group">
    <p class="row"><span class="row-main">${L('Meldingen aanzetten? Dan hoor je het bij nieuwe banktransacties, als een maand is afgesloten en als er nog bestanden ontbreken.',
      'Turn on notifications? You then hear about new bank transactions, a closed month and files that are still missing.')}</span></p>
    <button class="row tint" data-action="pushOn">${L('Meldingen aanzetten', 'Turn notifications on')}</button>
    <button class="row tint" data-action="pushLater">${L('Niet nu', 'Not now')}</button>
  </div>` : '');

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
  const toAdd = cardsToAdd(bank, state.cards, isoDate()); // paid for, but number and code are not in the app
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
      ${toAdd.length ? `
        <h2 class="section">${L('Gekocht, nog niet in de app', 'Bought, not in the app yet')}</h2>
        <div class="group">${toAdd.map((tx) => `
          <button class="row tint" data-action="addBought" data-id="${esc(tx.id)}"><span class="row-main">${L('Kaart toevoegen', 'Add card')}
            <small>${formatEuro(tx.gift.value)} · ${L('gekocht op', 'bought on')} ${dayShort(tx.date)}</small></span>${icon('plus')}</button>`).join('')}</div>` : ''}
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
// periods: [{ id, name, short, total, chosen }]; `kind` 'flow' draws them as narrow as the in/out chart's, for twelve months
function columnChart(periods, action, kind = '') {
  const most = Math.max(0, ...periods.map((period) => period.total));
  return `<ul class="columns${kind && ` ${kind}`}">${periods.map(({ id, name, short, total, chosen }) => {
    const label = `${name}: ${formatEuro(total)}`;
    return `
      <li><button class="column" data-action="${action}" data-id="${id}" aria-pressed="${chosen}" aria-label="${label}" title="${label}">
        <svg viewBox="0 0 24 92" aria-hidden="true">${columnShape(0, 24, columnHeight(total, most))}</svg>
        <span>${short}</span>
      </button></li>`;
  }).join('')}</ul>`;
}

// Two columns per month on one scale, by default money in beside money out. The chosen month stands out; a tap
// chooses another. `pair(month)` gives the two amounts, the left one green, and `keys` their names.
function flowChart(months, chosen, pair = (month) => [monthFigures(month).income, monthFigures(month).spending], keys = [L('In', 'In'), L('Uit', 'Out')]) {
  const sums = months.map((month) => [month, ...pair(month)]);
  const most = Math.max(0, ...sums.flatMap(([, income, spending]) => [income, spending]));
  return `
    <ul class="columns flow">${sums.map(([month, income, spending]) => {
      const label = `${monthName(month)}: ${keys[0].toLowerCase()} ${formatEuro(income)}, ${keys[1].toLowerCase()} ${formatEuro(spending)}`;
      return `
        <li><button class="column" data-action="pickMonth" data-id="${month}" aria-pressed="${month === chosen}" aria-label="${label}" title="${label}">
          <svg viewBox="0 0 24 92" preserveAspectRatio="none" aria-hidden="true">
            ${columnShape(0, 11, columnHeight(income, most), 'in')}${columnShape(13, 11, columnHeight(spending, most), 'out')}</svg>
          <span>${monthShort(month)}</span>
        </button></li>`;
    }).join('')}</ul>
    <p class="legend"><span><i class="key in"></i>${keys[0]}</span><span><i class="key out"></i>${keys[1]}</span></p>`;
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
  const till = tillOf(tx, cat); // then who it was for is the purchase's to say
  const others = cat === 'boodschappen' && !till ? (tx.shares ?? []).filter((share) => share.who !== US).map((share) => esc(shown(share.who))) : [];
  const gift = tx.gift ? `${cat === 'cadeaukaarten' ? '' : `${L('cadeaukaart', 'gift card')} `}${esc(tx.gift.shop)} ${formatEuro(tx.gift.value)}${cat !== 'cadeaukaarten' || !heldShops(bank).has(tx.gift.shop) ? ''
    : ` · ${tx.gift.shop === AH ? L('op de kaart', 'on the card') : L('op het saldo', 'on the balance')}`}`
    : toFill?.has(tx.id) ? `<span class="todo">${L('winkel invullen', 'fill in the shop')}</span>` : '';
  return `
    <li><button class="row tx" data-action="tx" data-id="${esc(tx.id)}">
      <span class="row-main">${esc(tx.name)} <small>${dayShort(tx.date)}${tx.early ? ` · ${L('voorlopig', 'provisional')}` : ''}${
        category ?` · <span${cat ? '' : ' class="todo"'}>${catName(cat)}</span>` : ''}${
        others.length ? ` · ${L('ook voor', 'also for')} ${others.join(', ')}` : ''}${gift ? ` · ${gift}` : ''}${
        till ? ` · ${L('deel van', 'part of')} ${formatEuro(till.total)}` : ''}${
        account ? ` · ${esc(nameOf(accountById(tx.acc)))}` : ''}</small></span>
      <span class="amount${tx.cents > 0 ? ' plus' : ''}">${signed(tx.cents)}</span>
    </button></li>`;
}

// A payment at the AH till in the groceries list: one row for the cards and the bank line of the pin part together.
function tillRow(purchase) {
  const others = purchase.shares.filter((share) => share.who !== US).map((share) => esc(shown(share.who)));
  const how = purchase.wait ? `${L('cadeaukaart', 'gift card')} · <span class="todo">${L('pin volgt', 'debit card to follow')}</span>`
    : purchase.total === purchase.cards ? L('cadeaukaart', 'gift card')
    : purchase.cards ? L('cadeaukaart + pin', 'gift card + debit card') : L('pin', 'debit card');
  return `
    <li><a class="row tx" href="#/uitgave/${purchase.id}">
      <span class="row-main">${esc(shown(purchase.store))} <small>${dayShort(dayOf(purchase))} · ${how}${
        others.length ? ` · ${L('ook voor', 'also for')} ${others.join(', ')}` : ''}</small></span>
      <span class="amount">${signed(-purchase.total)}</span>
    </a></li>`;
}

// what is left of a pot's amount, or how far it is over, in red then
const potLeft = (left) => `<span${left < 0 ? ' class="over-text"' : ''}>${left < 0
  ? L(`${formatEuro(-left)} erover`, `${formatEuro(-left)} over`) : L(`nog ${formatEuro(left)}`, `${formatEuro(left)} left`)}</span>`;

// A pot: a category with an amount per month, what was spent of it, and for the running month where today is.
function potRow(cat, spent, month) {
  const running = month === thisMonth();
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  const day = new Date().getDate();
  const left = cat.budget - spent;
  return `
    <li><a class="row meter-row" href="#/categorie/${cat.id}">
      <span class="row-main">${esc(shown(cat.name))} <small class="under">${formatEuro(spent)} ${L('van', 'of')} ${formatEuro(cat.budget)}</small></span>
      ${potLeft(left)}
      ${meterBar(spent / cat.budget, { over: left < 0, pace: running ? day / days : null })}
    </a></li>`;
}

// A pot on Overview, this month: name and what is left above the bar, what was spent of its amount below it
function potLine(cat, spent) {
  const left = cat.budget - spent;
  return `
    <a class="pot-line" href="#/categorie/${cat.id}">
      <span class="pot-head"><span>${esc(shown(cat.name))}</span>${potLeft(left)}</span>
      ${meterBar(spent / cat.budget, { over: left < 0, pace: new Date().getDate() / daysIn(thisMonth()) })}
      <small>${formatEuro(spent)} ${L('van', 'of')} ${formatEuro(cat.budget)}</small>
    </a>`;
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
    ...onBalance(bank, account.shop).map((tx) => ({
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

// "9 van 12 betaald", for the fixed costs of a month, with what they paid and what is still expected
function fixedSummary(month) {
  const costs = fixedCosts(bank, month).filter((cost) => cost.paid || cost.expected); // one that only started later is no cost of this month
  const paid = costs.filter((cost) => cost.paid).length;
  return {
    costs, text: L(`${paid} van ${costs.length} betaald`, `${paid} of ${costs.length} paid`), total: costs.reduce((sum, cost) => sum + cost.paid, 0),
    waiting: costs.filter((cost) => !cost.paid).reduce((sum, cost) => sum + cost.expected, 0),
  };
}
// the newest payment to a counterparty, by its rule key
const lastPaid = (key) => bank.txs.filter((tx) => ruleKey(tx.name) === key).sort((a, b) => b.date.localeCompare(a.date))[0];
// the date in `month` a fixed cost usually goes out; a 31st is the last day of a shorter month
const expectedOn = (cost, month) => `${month}-${String(Math.min(cost.day, daysIn(month))).padStart(2, '0')}`;

// What is still to come in `month` while it runs (`open`), and what it will probably have cost at its end. `due`: the
// fixed costs not paid yet, each on the day of the month it usually goes out (`late` once that day is past and
// it was not charged), and the payments the user planned; a plan for a later month is listed, but only this
// month's (`coming`) count. `sure` is what was `spent` plus what is still to come; `ahead` adds `rate` cents of
// everyday spending for every day that is left.
function outlook(month, spent, open) {
  const fixed = fixedSummary(month);
  const catOf = sorter(bank);
  const days = daysIn(month);
  const today = isoDate();
  const due = !open ? [] : [
    ...fixed.costs.filter((cost) => !cost.paid && cost.expected).map((cost) => ({ cost, date: expectedOn(cost, month), cat: catOf(lastPaid(cost.key)) }))
      .map(({ cost, date, cat }) => ({ date, name: cost.name, cents: cost.expected, late: date < today, cat,
        note: date < today ? L('Nog niet afgeschreven', 'Not charged yet') : catName(cat) })),
    ...plannedOpen(bank, isoDate()).map((plan) => ({ ...plan, note: L('Gepland', 'Planned') })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const coming = due.filter((each) => monthOf(each.date) === month);
  const waiting = coming.reduce((sum, each) => sum + each.cents, 0);
  const rate = open ? dayRate(bank, state.purchases, isoDate()) : 0;
  const sure = spent + waiting;
  return { fixed, due, coming, waiting, rate, sure, ahead: sure + Math.round(rate * (days - Number(isoDate().slice(8)))) };
}

// a payment still to come, on a small calendar page; a tap on a planned one takes it off again
function dueRow(each) {
  const row = `<span class="date-badge${each.late ? ' late' : ''}"><b>${Number(each.date.slice(8))}</b>${monthShort(monthOf(each.date))}</span>
    <span class="row-main">${esc(each.name)} <small>${each.note}</small></span>
    <span class="amount quiet">${formatEuro(each.cents)}</span>`;
  return each.id ? `<li><button class="row" data-action="unplan" data-id="${esc(each.id)}">${row}</button></li>` : `<li class="row">${row}</li>`;
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

// One thing to do on Overview: a small tile with its sign, what to do and, below it, why. The tile is blue for work
// in the app, orange for something that is missing, ending or at risk. `attrs` makes it a link or a button.
function todo(attrs, glyph, warn, text, why = '') {
  const tag = attrs.startsWith('href') ? 'a' : 'button';
  return `
    <li><${tag} class="row" ${attrs}><span class="todo-icon${warn ? ' warn' : ''}">${icon(glyph)}</span>
      <span class="row-main">${text}${why && ` <small>${why}</small>`}</span>${icon('next')}</${tag}></li>`;
}

// a line through a run of amounts, to show which way they went; the amount itself is written beside it
function spark(values) {
  if (values.length < 2) return '';
  const low = Math.min(...values);
  const high = Math.max(...values);
  const points = values.map((cents, index) => [4 + index * 292 / (values.length - 1), high > low ? 40 - (cents - low) / (high - low) * 34 : 23]);
  const [x, y] = points.at(-1);
  return `<svg class="spark" viewBox="0 0 300 44" aria-hidden="true">
    <polyline points="${points.map((point) => point.map((each) => each.toFixed(1)).join(',')).join(' ')}"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"/></svg>`;
}

// how many days `month` still has after today
function daysLeftText(month) {
  const rest = daysIn(month) - Number(isoDate().slice(8));
  return !rest ? L('laatste dag', 'last day') : rest === 1 ? L('nog 1 dag', '1 day left') : L(`nog ${rest} dagen`, `${rest} days left`);
}

// The top of Overview: what is on the Rabo current account now, and in a ring what of it still goes out this month:
// for sure the fixed costs and plans still to come (`coming`, together `waiting`), and at worst what is left in the
// pots, when every pot is used up. The rest of the ring is the rest of the balance. No Rabo account, no card.
function balanceCard(month, now, { coming, waiting }) {
  const lines = (account) => bank.txs.filter((tx) => tx.acc === account.id).length;
  const rabo = bank.accounts.filter((account) => account.bank === 'Rabo' && !account.card && !account.shop)
    .sort((a, b) => lines(b) - lines(a))[0]; // the current account: it has the most lines
  if (!rabo) return '';
  const held = new Map(); // a fixed cost to come in a pot's category is in that pot's rest as well
  for (const each of coming) if (each.cat) held.set(each.cat, (held.get(each.cat) ?? 0) + each.cents);
  const inPots = potsLeft(pots(), now.byCat, held);
  const cash = balanceOn(bank, rabo);
  const worst = waiting + inPots;
  const whole = Math.max(cash, worst, 1); // the ring is the balance, or all there is to pay when that is more
  const round = 2 * Math.PI * 54;
  let at = 0;
  const arcs = [['r-sure', waiting], ['r-pots', inPots], ['r-rest', whole - worst]].filter(([, cents]) => cents > 0).map(([name, cents], index, all) => {
    const length = cents / whole * round;
    const gap = all.length > 1 ? Math.min(4, length / 2) : 0;
    at += length;
    return `<circle class="${name}" cx="66" cy="66" r="54"${name === 'r-pots' ? ' stroke="url(#pot-hatch)"' : ''} stroke-dasharray="${(length - gap).toFixed(2)} ${(round - length + gap).toFixed(2)}" stroke-dashoffset="${(length - at).toFixed(2)}"/>`;
  });
  return `
    <a class="summary" href="#/vast">
      <div class="summary-top">
        <p class="footnote">${esc(rabo.name)}</p>
        <p class="footnote">${daysLeftText(month)}</p>
      </div>
      <p class="total">${formatEuro(cash)}</p>
      <div class="to-pay">
        <div class="ring">
          <svg viewBox="0 0 132 132" aria-hidden="true"><defs><pattern id="pot-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect class="hatch-bg" width="6" height="6"/><rect class="hatch-line" width="2.5" height="6"/></pattern></defs>${arcs.join('')}</svg>
          <p><span>${L('nog te betalen', 'still to pay')}</span><strong${worst > cash ? ' class="over-text"' : ''}>${wholeEuro(worst)}</strong><span>worst case</span></p>
        </div>
        <ul class="ring-key">
          <li><i class="key k-out"></i><span>${coming.length ? L(`Vast · ${coming.length} open`, `Fixed · ${coming.length} open`) : L('Vast', 'Fixed')}<strong>${formatEuro(waiting)}</strong></span></li>
          <li><i class="key k-pots"></i><span>${L('Potjes, nog over', 'Left in pots')}<strong>${formatEuro(inPots)}</strong></span></li>
        </ul>
      </div>
    </a>`;
}

// Insight's card for the running month: what will probably be left of the salary when the month is over. The salary is
// the average of the three months before (salaryBase), so it moves on every month. Under the bar the salaries
// themselves, with the months the average takes marked. `now` is this month's figures. No salary to go by: no card.
function salaryCard(month, now, { waiting, sure, ahead }) {
  const { past, counted, usual } = salaryBase(bank, state.purchases, month);
  if (!usual) return '';
  const left = usual - ahead;
  const share = (cents) => `${Math.round(cents / usual * 100)}%`;
  const end = (cents) => Math.min(Math.max(cents, 0) / usual, 1) * 100; // where on the bar an amount reaches
  const parts = [['out', 0, end(now.spending)], ['sure', end(now.spending), end(sure)], ['ahead', end(sure), end(ahead)]].filter(([, from, to]) => to > from);
  const cells = [...past, { month, ...now }].map((each) => {
    const cents = each.byCat.get('salaris') ?? 0;
    const kind = each.month === month ? ' class="this"' : counted.includes(each) ? ' class="in-average"' : '';
    return `<li${kind}><span>${monthShort(each.month)}</span><b>${cents ? Math.round(cents / 100).toLocaleString(LOCALE) : '—'}</b></li>`;
  }).join('');
  const span = counted.length > 1 ? L(`${monthLong(counted[0].month)} t/m ${monthLong(counted.at(-1).month)}`,
    `${monthLong(counted[0].month)} to ${monthLong(counted.at(-1).month)}`) : monthLong(counted[0].month);
  return `
    <section class="summary">
      <div class="summary-top">
        <p class="footnote">${left < 0 ? L(`Verwacht tekort eind ${monthLong(month)}`, `Expected short at the end of ${monthLong(month)}`)
          : L(`Verwacht over eind ${monthLong(month)}`, `Expected left at the end of ${monthLong(month)}`)}</p>
        <p class="footnote">${daysLeftText(month)}</p>
      </div>
      <p class="total${left < 0 ? ' over-text' : ''}">${wholeEuro(Math.abs(left))}</p>
      <p class="footnote">${L(`van je gemiddelde salaris van ${wholeEuro(usual)}`, `of your average salary of ${wholeEuro(usual)}`)}</p>
      <p class="use-head"><strong>${L('Salaris gebruikt', 'Salary used')}</strong>
        <span>${ahead === now.spending ? share(now.spending) : L(`${share(now.spending)} nu, ${share(ahead)} verwacht`, `${share(now.spending)} now, ${share(ahead)} expected`)}</span></p>
      <svg class="use" aria-hidden="true"><rect class="track" width="100%" height="100%" rx="4"/>${parts.map(([name, from, to]) =>
        `<rect class="${name}" x="${from.toFixed(1)}%" width="${(to - from).toFixed(1)}%" height="100%" rx="${name === 'out' ? 4 : 3}"/>`).join('')}</svg>
      <p class="legend use-legend"><span><i class="key k-out"></i>${L('Uit', 'Out')} ${wholeEuro(now.spending)}</span>${
        waiting ? `<span><i class="key k-sure"></i>${L('Komt nog', 'Still to come')} ${wholeEuro(waiting)}</span>` : ''}${
        ahead > sure ? `<span><i class="key k-ahead"></i>${L('Rest verwacht', 'Rest expected')} ${wholeEuro(ahead - sure)}</span>` : ''}${
        left > 0 ? `<span><i class="key k-free"></i>${L('Over', 'Left')} ${wholeEuro(left)}</span>` : ''}</p>
      <div class="salary">
        <h3>${L('Salaris per maand', 'Salary per month')}</h3>
        <ol class="months">${cells}</ol>
        <div class="average-mark">${'<span></span>'.repeat(past.length - counted.length)}<p class="span-${counted.length}">${L('gemiddeld', 'average')} ${wholeEuro(usual)}</p><span></span></div>
        <p class="footnote">${L(`Het gemiddelde is van ${span}; ${monthLong(month)} telt mee vanaf ${monthLong(shiftMonth(month, 1))}.`,
          `The average covers ${span}; ${monthLong(month)} counts from ${monthLong(shiftMonth(month, 1))}.`)}</p>
      </div>
    </section>`;
}

// ---------- the savings goal ----------
// Overview's first card: what every month saved against what the goal saves each month, as bars around this month.
// A month tapped opens a panel under the bars with its figures and the net worth on its way to the goal's amounts.

const goalWorth = (month) => worthOn(month === thisMonth() ? '9999' : `${month}-31`);
const barEuro = (cents) => `${cents < 0 ? '−' : ''}${Math.round(Math.abs(cents) / 100).toLocaleString(LOCALE)}`; // on a bar: no euro sign
const monthYear = (month) => `${monthShort(month)} ${month.slice(0, 4)}`;

// One bar per month of `list` (goalMonths): the amount to save each month is 60 high, a bar that would run off the
// chart is cut short with a break in it. A month to come is an empty frame up to that amount; the running month has
// the frame and its striped bar so far, faint while it counts salary still to come (`guess`). Every month is a button;
// `chosen` is the one tapped.
function goalBars(list, chosen, monthly, guess) {
  const slot = 326 / list.length;
  const bars = list.map((each, index) => {
    const x = slot * index + slot / 2;
    const up = each.saved >= 0;
    const tall = Math.abs(each.saved) / monthly * 60;
    const height = Math.max(2, Math.min(tall, up ? 84 : 65));
    const top = up ? 100 - height : 100;
    const text = (words, y, kind = '') => `<text${kind && ` class="${kind}"`} x="${x.toFixed(1)}" y="${y.toFixed(1)}">${words}</text>`;
    const frame = ['now', 'next'].includes(each.kind) ? `<rect class="frame" x="${(x - 11.25).toFixed(1)}" y="41" width="22.5" height="58" rx="4"/>` : '';
    const bar = each.kind === 'next' ? '' : `
      <rect class="${each.kind}${each.kind === 'now' && guess ? ' guess' : ''}" x="${(x - 12).toFixed(1)}" y="${top.toFixed(1)}" width="24" height="${height.toFixed(1)}" rx="${height < 8 ? 1 : 4}"/>${tall > height
        ? `<path class="break" d="M${(x - 14).toFixed(1)} ${(up ? top + 19 : top + height - 19).toFixed(1)} l7 -4 l7 4 l7 -4 l7 4 v5 l-7 -4 l-7 4 l-7 -4 l-7 4z"/>` : ''}
      ${text(`${each.kind === 'now' && guess ? '≈ ' : ''}${barEuro(each.saved)}`, up ? (frame ? Math.min(top, 41) : top) - 5 : top + height + 14, each.kind === 'now' ? `now-text${guess ? ' guess' : ''}` : '')}`;
    const picked = each.month === chosen;
    return `<g class="slot${picked ? ' picked' : ''}">${picked ? `<rect class="band" x="${(x - 19).toFixed(1)}" y="0" width="38" height="196" rx="9"/>` : ''}
      ${frame}${bar}${text(monthShort(each.month), 192, 'month')}</g>`;
  }).join('');
  const hits = list.map((each, index) => `<rect class="hit" x="${(slot * index).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="196"
    role="button" tabindex="0" data-action="pickGoal" data-id="${each.month}" aria-pressed="${each.month === chosen}"
    aria-label="${monthName(each.month)}: ${each.kind === 'next' ? L('nog te sparen', 'still to save') : each.kind === 'now' && guess ? L('verwacht gespaard', 'expected saved')
      : L('gespaard', 'saved')} ${wholeEuro(each.saved)}"/>`).join('');
  return `
    <svg class="goal-bars${chosen ? ' has-pick' : ''}" viewBox="0 0 326 196" role="group" aria-label="${L('Gespaard per maand', 'Saved per month')}">
      <defs><pattern id="goal-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect class="hatch-bg" width="6" height="6"/><rect class="hatch-line" width="2.5" height="6"/></pattern></defs>
      <line class="target" x1="0" x2="326" y1="40" y2="40"/><line class="zero" x1="0" x2="326" y1="100" y2="100"/>
      <text class="target-text" x="324" y="34">${L('doel', 'goal')} ${wholeEuro(monthly)}</text>
      ${bars}${hits}
    </svg>`;
}

// The net worth at the end of each month of `history` and, dashed, the plan from the end of the last full month
// (`base`) on at the goal's amount a month, up to its highest amount; a dotted line for each amount, the month it is
// reached at its dot. `chosen` is marked with a line and a dot. With `guess` the last point counts salary still to
// come, so the way to it is faint.
function goalLine(goal, history, base, steps, chosen, guess) {
  const last = shiftMonth(thisMonth(), -1);
  const first = history[0].month;
  const open = steps.filter((step) => step.month);
  const end = [open.at(-1)?.month ?? '', shiftMonth(thisMonth(), 3), chosen].sort().at(-1);
  const span = Math.max(1, monthsFrom(first, end));
  const planAt = (at) => base + goal.monthly * (at - monthsFrom(first, last)); // `at`: months after `first`, may be part of one
  const reachAt = (cents) => monthsFrom(first, last) + (cents - base) / goal.monthly;
  const planEnd = open.length ? reachAt(open.at(-1).cents) : span;
  const values = [...history.map((point) => point.worth), goal.steps.at(-1).cents, planAt(planEnd)];
  const low = Math.min(0, ...values);
  const high = Math.max(...values);
  const x = (at) => (4 + at / span * 276).toFixed(1);
  const y = (cents) => (112 - (cents - low) / (high - low || 1) * 94).toFixed(1);
  const lines = steps.map((step, index) => {
    const top = index === steps.length - 1;
    const label = `${esc(step.name)} · ${wholeEuro(step.cents)}${step.month ? '' : ` · ${L('bereikt', 'reached')}`}`;
    const at = reachAt(step.cents);
    const far = Number(x(at)) > 210;
    return `<line class="step" x1="4" x2="280" y1="${y(step.cents)}" y2="${y(step.cents)}"/>
      <text x="${top ? 4 : 280}" y="${(Number(y(step.cents)) - 6).toFixed(1)}"${top ? '' : ' text-anchor="end"'}>${label}</text>${step.month ? `
      <circle class="mark" cx="${x(at)}" cy="${y(step.cents)}" r="5.5"/>
      <text class="when" x="${far ? 280 : (Number(x(at)) + 7).toFixed(1)}" y="${(Number(y(step.cents)) + (far ? 22 : 15)).toFixed(1)}"${far ? ' text-anchor="end"' : ''}>${monthYear(step.month)}</text>` : ''}`;
  }).join('');
  const chosenAt = monthsFrom(first, chosen);
  const chosenWorth = history.find((point) => point.month === chosen)?.worth ?? planAt(chosenAt);
  // the years between the first and the last month, at their January, where they do not run into the month at either end
  const years = Array.from({ length: Number(end.slice(0, 4)) - Number(first.slice(0, 4)) }, (unused, index) => String(Number(first.slice(0, 4)) + index + 1))
    .map((year) => ({ year, at: monthsFrom(first, `${year}-01`) })).filter(({ at }) => Number(x(at)) > 52 && Number(x(at)) < 232);
  return `
    <svg class="goal-line" viewBox="0 0 284 130" role="img" aria-label="${L('Vermogen en het plan', 'Net worth and the plan')}: ${steps.map((step) =>
      `${esc(step.name)} ${wholeEuro(step.cents)} ${step.month ? monthName(step.month) : L('bereikt', 'reached')}`).join(', ')}">
      <line class="base" x1="4" x2="280" y1="${y(0)}" y2="${y(0)}"/>
      ${lines}
      <line class="rule" x1="${x(chosenAt)}" x2="${x(chosenAt)}" y1="22" y2="112"/>
      <polyline class="stroke" points="${(guess ? history.slice(0, -1) : history).map((point) => `${x(monthsFrom(first, point.month))},${y(point.worth)}`).join(' ')}"/>${guess ? `
      <line class="stroke guess" x1="${x(history.length - 2)}" y1="${y(history.at(-2).worth)}" x2="${x(history.length - 1)}" y2="${y(history.at(-1).worth)}"/>` : ''}
      <line class="plan" x1="${x(monthsFrom(first, last))}" y1="${y(base)}" x2="${x(planEnd)}" y2="${y(planAt(planEnd))}"/>
      <circle class="dot${guess && chosen === history.at(-1).month ? ' guess' : ''}" cx="${x(chosenAt)}" cy="${y(chosenWorth)}" r="4.5"/>
      <text x="4" y="127">${monthYear(first)}</text>
      ${years.map(({ year, at }) => `<text x="${x(at)}" y="127" text-anchor="middle">${year}</text>`).join('')}
      <text x="280" y="127" text-anchor="end">${monthYear(end)}</text>
    </svg>`;
}

// The panel of the month tapped: three figures, a note while salary is still to come (`toCome`), and the line to the goal.
function goalPop(goal, data, history, chosen, toCome) {
  const each = data.list.find((item) => item.month === chosen);
  const guess = toCome.cents;
  const end = L(`eind ${monthLong(chosen)}`, `end of ${monthLong(chosen)}`);
  const span = toCome.months.length > 1 ? `${monthShort(toCome.months[0])}–${monthShort(toCome.months.at(-1))}` : monthShort(toCome.months[0] ?? chosen);
  const rows = {
    now: [guess ? [L('Verwacht gespaard', 'Expected saved'), `≈ ${wholeEuro(each.saved)}`] : [L('Gespaard tot nu', 'Saved so far'), wholeEuro(each.saved)],
      [L(`Plan ${end}`, `Plan ${end}`), wholeEuro(data.plan)], [L('Vermogen nu', 'Net worth now'), formatEuro(each.worth - guess)]],
    done: [[L('Gespaard', 'Saved'), wholeEuro(each.saved)], [L('Doel', 'Goal'), wholeEuro(goal.monthly)], [L(`Vermogen ${end}`, `Net worth ${end}`), formatEuro(each.worth)]],
    before: [[L('Gespaard', 'Saved'), wholeEuro(each.saved)], [L(`Vermogen ${end}`, `Net worth ${end}`), formatEuro(each.worth)]],
    next: [[L('Te sparen', 'To save'), wholeEuro(goal.monthly)], [L(`Plan ${end}`, `Plan ${end}`), wholeEuro(each.worth)]],
  }[each.kind];
  const [tone, chip] = {
    now: ['', guess ? L('verwacht', 'expected') : L('loopt nog', 'running')],
    next: ['', L('plan', 'plan')],
    before: [' quiet', L('voor het doel', 'before the goal')],
    done: each.saved >= goal.monthly ? [' met', L('gehaald', 'made it')] : [' quiet', L('onder het doel', 'under the goal')],
  }[each.kind];
  return `
    <section class="goal-pop" data-at="${((data.list.indexOf(each) + 0.5) / data.list.length).toFixed(3)}" aria-label="${monthName(chosen)}">
      <div class="pop-head"><h3>${monthName(chosen)}</h3><span class="chip${tone}">${chip}</span></div>
      <dl class="pop-figures">${rows.map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`).join('')}</dl>
      ${each.kind === 'now' && guess ? `<p class="pop-note">${icon('warn')}<span>${L(`Nog niet alle salarissen zijn binnen. Gerekend met ${wholeEuro(guess)} die nog komt: het gemiddelde van ${span} min wat er al is. Zonder: ${wholeEuro(each.saved - guess).replace(' ', '&nbsp;')}.`,
        `Not all salaries are in yet. Counting ${wholeEuro(guess)} still to come: the average of ${span} less what came in. Without it: ${wholeEuro(each.saved - guess).replace(' ', '&nbsp;')}.`)}</span></p>` : ''}
      <div class="pop-graph-head"><h4>${L('Op weg naar het doel', 'On the way to the goal')}</h4>
        <span>${L(`bij ${wholeEuro(goal.monthly)} p/m`, `at ${wholeEuro(goal.monthly)} a month`)}</span></div>
      ${goalLine(goal, history, data.base, data.steps, chosen, guess)}
    </section>`;
}

// The card itself; without a goal, a row that sets one.
function goalCard(month) {
  const goal = bank.goal;
  const head = `<h2 class="section split-head"><span>${L('Doelen', 'Goals')}</span>${goal ? `<span>${L(`${wholeEuro(goal.monthly)} p/m`, `${wholeEuro(goal.monthly)} a month`)}</span>` : ''}</h2>`;
  if (!goal) return `${head}<div class="group"><button class="row tint" data-action="editGoal">${L('Spaardoel instellen', 'Set a savings goal')}</button></div>`;
  // the line starts where the data does, and at least at the end of last month, where the plan starts
  const first = [monthOf(bank.since || isoDate()), shiftMonth(month, -1)].sort()[0];
  // until every salary of the month is in, the month counts what is still to come of the usual salary, shown faint
  const toCome = salaryToCome(bank, state.purchases, month);
  const guess = toCome.cents;
  const worthAt = (each) => goalWorth(each) + (each === month ? guess : 0);
  const data = goalMonths(goal, worthAt, month, first);
  const chosen = data.list.some((each) => each.month === view.goal) ? view.goal : '';
  const history = Array.from({ length: monthsFrom(first, month) + 1 }, (unused, index) => shiftMonth(first, index)).map((each) => ({ month: each, worth: worthAt(each) }));
  const next = data.steps.find((step) => step.month);
  const kinds = new Set(data.list.map((each) => each.kind));
  const keys = [['before', 'k-before', L('Voor het doel', 'Before the goal')], ['done', 'k-out', L('Gespaard', 'Saved')],
    ['now', `k-pots${guess ? ' guess' : ''}`, guess ? L('Verwacht', 'Expected') : L('Loopt nog', 'Running')], ['next', 'k-ahead', L('Nog te sparen', 'Still to save')]]
    .filter(([kind]) => kinds.has(kind));
  return `${head}
    <section class="summary goal">
      <button class="goal-head" data-action="editGoal">
        <span class="goal-icon">${icon('home')}</span>
        <span class="row-main"><strong>${esc(goal.name)}</strong><small>${L(`sparen tot ${wholeEuro(goal.steps.at(-1).cents)}`, `saving up to ${wholeEuro(goal.steps.at(-1).cents)}`)}</small></span>
        <span class="goal-next">${next ? `<small>${wholeEuro(next.cents)}</small><b>${monthYear(next.month)}</b>` : `<b>${L('Bereikt', 'Reached')}</b>`}</span>
      </button>
      <p class="footnote">${guess ? L(`Verwacht gespaard in ${monthLong(month)}`, `Expected saved in ${monthLong(month)}`) : L(`Gespaard in ${monthLong(month)}, tot nu`, `Saved in ${monthLong(month)}, so far`)}</p>
      <p class="total${guess ? ' guess' : ''}">${guess ? '≈ ' : ''}${wholeEuro(data.list.find((each) => each.kind === 'now').saved)}</p>
      <p class="footnote">${guess ? L(`Met ${wholeEuro(guess)} salaris dat nog komt · tik op een maand`, `With ${wholeEuro(guess)} of salary still to come · tap a month`)
        : L('Tik op een maand voor meer', 'Tap a month for more')}</p>
      <div class="goal-chart">${goalBars(data.list, chosen, goal.monthly, guess)}${chosen ? goalPop(goal, data, history, chosen, toCome) : ''}</div>
      <p class="legend goal-legend">${keys.map(([, key, text]) => `<span><i class="key ${key}"></i>${text}</span>`).join('')}</p>
    </section>`;
}

function overviewScreen() {
  const month = thisMonth();
  const now = monthFigures(month);
  const today = isoDate();
  // an account with nothing on it (the savings account kept at 0) needs no new files
  const oldest = Math.max(0, ...bank.accounts.filter((account) => !account.shop && account.balance !== 0).map((account) => daysLeft(today, isoDate(new Date(account.uploaded)))));
  const coming = outlook(month, now.spending, Number(today.slice(8)) < daysIn(month));
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
        ${blank(L('Nog geen bankgegevens', 'No bank data yet'), L('Upload het CSV-bestand van je Rabo-rekening, het CSV- of PDF-bestand van je Rabo-creditcard, of het PDF-afschrift van Openbank.',
          'Upload the CSV file of your Rabo account, the CSV or PDF file of your Rabo credit card, or the PDF statement from Openbank.'))}
        <div class="group">${uploadRow()}</div>
        <div class="group">${cards}</div>`,
    };
  }
  // what to do: work in the app first, then what is missing, ending or at risk
  const names = (accounts) => accounts.map((account) => esc(account.name)).join(', ');
  const lastMonth = shiftMonth(month, -1);
  const missing = missingFiles();
  const ending = sharing ? Object.entries(links.banks).filter(([, until]) => daysLeft(until.slice(0, 10), today) <= 14) : [];
  const expiring = state.cards.filter((card) => balance(card) > 0 && ['soon', 'expired'].includes(expiryState(card.expiry, today)));
  const toFill = giftsToFill(bank).length;
  const toAdd = cardsToAdd(bank, state.cards, today);
  const todos = [
    open && todo('href="#/categorie/open"', 'list', false, L(`${plural(open, 'transactie', 'transacties')} indelen`, `Sort ${plural(open, 'transaction', 'transactions')}`)),
    toFill && todo('data-action="fillGifts"', 'card', false, L(`${plural(toFill, 'cadeaukaart', 'cadeaukaarten')} invullen`,
      `Fill in ${plural(toFill, 'gift card', 'gift cards')}`), L('Winkel en waarde', 'Shop and value')),
    toAdd.length && todo(`data-action="addBought" data-id="${esc(toAdd[0].id)}"`, 'card', false, L(`${plural(toAdd.length, 'AH-kaart', 'AH-kaarten')} toevoegen`,
      `Add ${plural(toAdd.length, 'AH card', 'AH cards')}`), L('Kaartnummer en beveiligingscode', 'Card number and security code')),
    missing.length ? todo('data-action="upload"', 'upload', true, L(`Bestand van ${monthLong(lastMonth)} uploaden`, `Upload the file for ${monthLong(lastMonth)}`),
      L(`Nog niet compleet: ${names(missing)}`, `Not complete yet: ${names(missing)}`))
      : oldest > STALE && todo('data-action="upload"', 'upload', true, L('Nieuwe bankbestanden uploaden', 'Upload new bank files'),
        L(`De laatste upload is ${oldest} dagen oud`, `The last upload is ${oldest} days old`)),
    gaps.length && todo('data-action="upload"', 'warn', true, L(`Er ontbreken transacties bij ${names(gaps)}`, `Transactions are missing for ${names(gaps)}`),
      L('Upload ook de periode ertussen', 'Upload the period in between as well')),
    ...ending.map(([name, until]) => todo('href="#/meer"', 'warn', true, daysLeft(until.slice(0, 10), today) < 0
      ? L(`${name}-koppeling is verlopen`, `${name} link has ended`)
      : L(`${name}-koppeling loopt af op ${dayShort(until.slice(0, 10)).replace(' ', '&nbsp;')}`, `${name} link ends on ${dayShort(until.slice(0, 10)).replace(' ', '&nbsp;')}`),
    L('Koppel opnieuw in Instellingen', 'Link again in Settings'))),
    ...expiring.map((card) => todo(`href="#/kaart/${card.id}"`, 'warn', true, L(`AH-kaart ${last4(card)}`, `AH card ${last4(card)}`),
      `${expiryLabel(card)} · ${formatEuro(balance(card))} ${L('op de kaart', 'on the card')}`)),
    state.needsBackup && !sharing && todo('data-action="export"', 'warn', true, L('Back-up maken', 'Make a backup'),
      L('Er zijn nieuwe gegevens zonder back&#8209;up', 'There is new data without a backup')),
  ].filter(Boolean);
  // when the bank links last brought news; with sharing off there are none
  const linked = sharing ? Object.keys(links.banks) : [];
  const clock = links.ok && clockText(links.ok);
  const fetched = !linked.length || !links.ok ? '' : links.failed.length
    ? `<p class="fetched failed">${L(`Ophalen bij ${links.failed.join(' en ')} lukte niet`, `Fetching from ${links.failed.join(' and ')} failed`)}</p>`
    : `<p class="fetched">${L(`${linked.join(' en ')} bijgewerkt ${clock}`, `${linked.join(' and ')} updated ${clock}`)}</p>`;
  // net worth at the end of each of the last twelve months that are counted; this month stands at today
  const first = bank.since ? monthOf(bank.since) : '';
  const worths = Array.from({ length: 12 }, (unused, index) => shiftMonth(month, index - 11)).filter((each) => each >= first)
    .map((each) => worthOn(each === month ? '9999' : `${each}-31`));
  const grown = worthOn('9999') - worthOn(dayBefore(`${month}-01` > bank.since ? `${month}-01` : bank.since));
  return {
    html: `${title}
      ${fetched}
      ${goalCard(month)}
      ${balanceCard(month, now, coming)}
      <h2 class="section split-head"><span>${L('Potjes', 'Pots')}</span>${pots().length ? `<span><i class="key today"></i>${L('vandaag', 'today')}</span>` : ''}</h2>
      ${pots().length ? `<div class="summary pots">${pots().map((cat) => potLine(cat, now.byCat.get(cat.id) ?? 0)).join('')}</div>`
        : `<div class="group"><a class="row tint" href="#/potjes">${L('Kies een bedrag per maand voor een potje', 'Choose an amount per month for a pot')}</a></div>`}
      ${todos.length ? `
        <h2 class="section split-head"><span>${L('Te doen', 'To do')}</span><span>${todos.length}</span></h2>
        <ul class="group todos">${todos.join('')}</ul>` : ''}
      ${pushNotice()}
      <h2 class="section split-head"><span>${L('Vermogen', 'Net worth')}</span><span>${worths.length > 1 ? L(`${worths.length} maanden`, `${worths.length} months`) : ''}</span></h2>
      <a class="summary worth-card" href="#/inzicht/vermogen">
        <p class="tile-total">${formatEuro(worthOn('9999'))}</p>
        <p class="footnote${grown >= 0 ? ' plus' : ''}">${signed(grown)} ${L('deze maand', 'this month')}</p>
        ${spark(worths)}
      </a>
      <h2 class="section">${L('Beleggen', 'Investing')}</h2>
      ${investCard()}`,
  };
}

// ---------- investing ----------
// What was put in comes from the bank lines sorted as Beleggen, and what was bought with it from the purchases the
// user enters (bank.js). A fund is worth its price of the last hour; what was put in and not spent on a fund is still
// cash at the broker. `shares`, `worth` and `result` are null while a fund has no price yet.
function investFigures() {
  const lines = deposits(bank);
  const put = invested(lines);
  const funds = holdings(bank).map((fund) => {
    const euros = quotes.prices[fund.stock];
    return { ...fund, euros, worth: euros > 0 ? Math.round(fund.qty * euros * 100) : null };
  });
  const cash = put - bought(bank);
  const shares = funds.every((fund) => fund.worth !== null) ? funds.reduce((sum, fund) => sum + fund.worth, 0) : null;
  const worth = shares === null ? null : shares + cash;
  return { lines, put, funds, cash, shares, worth, result: worth === null ? null : worth - put };
}

const count = (qty) => Math.abs(qty).toLocaleString(LOCALE, { maximumFractionDigits: 4 });
const pricesAt = () => (holdings(bank).length && quotes.ok ? `${L('koersen', 'prices')} ${clockText(quotes.ok)}` : '');
const noPrices = () => (sharing ? L('De koersen worden opgehaald.', 'The prices are being fetched.')
  : L('Koersen ophalen kan alleen als delen aan staat, bij Instellingen.', 'Prices can only be fetched with sharing on, in Settings.'));

// A result as a label: the amount and, with something to hold it against (`of`), the share. A gain is green; a loss
// stays plain, as red is kept for a pot that is overspent and a period that ended short.
function resultLabel(cents, of = 0) {
  const share = of > 0 ? ` · ${cents < 0 ? '−' : '+'}${(Math.abs(cents) / of * 100).toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : '';
  return `<span class="change${cents > 0 ? ' gain' : ''}">${signed(cents)}${share}</span>`;
}

// Overview: what was put in beside what it is worth now, and the difference since the start.
function investCard() {
  const { put, worth, result } = investFigures();
  if (!put && !bank.trades.length) {
    return `<div class="group"><a class="row tint" href="#/beleggen">${L('Houd bij wat je beleggingen waard zijn', 'Keep track of what your investments are worth')}</a></div>`;
  }
  return `
    <a class="summary worth-card" href="#/beleggen">
      <div class="pair">
        <div><p class="footnote">${L('Ingelegd', 'Invested')}</p><p class="tile-total">${formatEuro(put)}</p></div>
        <div><p class="footnote">${L('Waarde nu', 'Worth now')}</p><p class="tile-total">${worth === null ? '—' : formatEuro(worth)}</p></div>
      </div>
      <p class="footnote result">${worth === null ? noPrices()
        : !bank.trades.length ? L('Vul in wat je kocht om het resultaat te zien.', 'Enter what you bought to see the result.')
          : `${resultLabel(result, put)} ${L('sinds de start', 'since the start')}`}</p>
    </a>`;
}

// The worth now beside what was put in, the result since the start, and a bar for where the money is: in funds, or
// not invested yet.
function investTop({ put, cash, shares, worth, result }) {
  if (worth === null) {
    return `<div class="summary-top"><p class="footnote">${L('Waarde nu', 'Worth now')}</p><p class="footnote">${L('ingelegd', 'invested')} ${formatEuro(put)}</p></div>
      <p class="total small">—</p><p class="footnote result">${noPrices()}${cash >= 0 ? ` ${L('Nog niet belegd', 'Not invested yet')}: ${formatEuro(cash)}.` : ''}</p>`;
  }
  return `
    <div class="summary-top"><p class="footnote">${L('Waarde nu', 'Worth now')}</p><p class="footnote">${L('ingelegd', 'invested')} ${formatEuro(put)}</p></div>
    <p class="total small">${formatEuro(worth)}</p>
    <p class="footnote result">${bank.trades.length ? `${resultLabel(result, put)} ${L('sinds de start', 'since the start')}`
      : L('Vul in wat je kocht om het resultaat te zien.', 'Enter what you bought to see the result.')}</p>
    ${cash < 0 ? `<p class="footnote result">${L(`Er is ${formatEuro(-cash)} meer gekocht dan ingelegd. Mist er een storting, of klopt een aankoop niet?`,
      `${formatEuro(-cash)} more was bought than invested. Is a deposit missing, or is a purchase wrong?`)}</p>`
    : worth > 0 ? `
      <div class="split">
        ${meterBar(shares / worth)}
        <p class="legend"><span><i class="key fixed"></i>${L('In fondsen', 'In funds')} ${formatEuro(shares)}</span>
          <span><i class="key rest"></i>${L('Nog niet belegd', 'Not invested yet')} ${formatEuro(cash)}</span></p>
      </div>` : ''}`;
}

// A fund held: how many at which price and what they cost, its worth and, under it, the result. `open` and `close`
// make the row a link or a button. Once some of it was sold, what it cost is what was paid less what came back.
const fundRow = (fund, open, close) => `
  <li>${open}
    <span class="row-main">${esc(fund.name)} <small>${count(fund.qty)} × ${fund.euros > 0 ? formatEuro(Math.round(fund.euros * 100)) : L('koers nog niet bekend', 'price not known yet')}
      · ${bank.trades.some((trade) => trade.stock === fund.stock && trade.qty < 0) ? L('per saldo betaald', 'net paid') : L('gekocht voor', 'bought for')} ${formatEuro(fund.cents)}</small></span>
    ${fund.worth === null ? '' : `<span class="stack"><span class="amount">${formatEuro(fund.worth)}</span>${resultLabel(fund.worth - fund.cents)}</span>`}
  ${close}</li>`;

// Insight: the worth and where it is, what was put in month by month (a tap on a month chooses it, as on the chart
// at the top), and each fund. `months`: the months of the charts; `chosen`: the month on screen, a year when that is shown.
function investInsight(months, chosen) {
  const now = investFigures();
  if (!now.put && !bank.trades.length) return '';
  const during = (list, period) => list.filter((each) => each.date.startsWith(period));
  const put = invested(during(now.lines, chosen));
  const sum = (trades) => trades.reduce((total, trade) => total + Math.abs(trade.cents), 0);
  const paid = sum(during(bank.trades, chosen).filter((trade) => trade.qty > 0));
  const back = sum(during(bank.trades, chosen).filter((trade) => trade.qty < 0));
  const name = chosen.length === 4 ? chosen : monthName(chosen);
  const money = Math.max(put, paid, back) >= 1000000 ? wholeEuro : formatEuro; // three amounts of five digits and cents do not fit side by side
  return `
    <h2 class="section split-head" id="beleggen"><span>${L('Beleggen', 'Investing')}</span><span>${pricesAt()}</span></h2>
    <section class="summary worth">
      ${investTop(now)}
      <div class="detail">
        <p class="use-head"><strong>${L('Ingelegd per maand', 'Invested per month')}</strong><span>${name}</span></p>
        ${columnChart(months.map((month) => ({ id: month, name: monthName(month), short: monthShort(month),
          total: Math.max(0, invested(during(now.lines, month))), chosen: month === chosen })), 'pickMonth', 'flow')}
        <dl class="trio">
          <div><dt>${L('Ingelegd', 'Invested')}</dt><dd>${money(put)}</dd></div>
          <div><dt>${L('Gekocht', 'Bought')}</dt><dd>${money(paid)}</dd></div>
          <div><dt>${L('Verkocht', 'Sold')}</dt><dd>${money(back)}</dd></div>
        </dl>
      </div>
    </section>
    <ul class="group">
      ${now.funds.map((fund) => fundRow(fund, '<a class="row" href="#/beleggen">', `${icon('next')}</a>`)).join('')}
      <li><a class="row" href="#/beleggen"><span class="row-main">${L('Aankopen en stortingen', 'Purchases and deposits')}</span>${icon('next')}</a></li>
    </ul>`;
}

function investScreen() {
  const now = investFigures();
  const catOf = sorter(bank);
  const stray = strayDeposits(bank);
  const trades = [...bank.trades].sort((a, b) => b.date.localeCompare(a.date));
  const tradeRow = (trade) => `
    <li><button class="row tx" data-action="editTrade" data-id="${esc(trade.id)}">
      <span class="row-main">${trade.qty < 0 ? L('Verkocht', 'Sold') : L('Gekocht', 'Bought')} ${count(trade.qty)} × ${formatEuro(Math.round(trade.cents / trade.qty))}
        <small>${dayShort(trade.date)} · ${esc(trade.name)}</small></span>
      <span class="amount${trade.qty < 0 ? ' plus' : ''}">${trade.qty < 0 ? signed(-trade.cents) : formatEuro(trade.cents)}</span>
    </button></li>`;
  return {
    html: `
      <header class="navbar">${backButton()}<h1>${L('Beleggen', 'Investing')}</h1><span></span></header>
      <section class="summary worth">${investTop(now)}</section>
      <h2 class="section split-head"><span>${L('Fondsen', 'Funds')}</span><span>${pricesAt()}</span></h2>
      <ul class="group">
        ${now.funds.map((fund) => fundRow(fund, `<button class="row" data-action="trade" data-id="${esc(fund.stock)}">`, '</button>')).join('')}
        <li><button class="row tint" data-action="addTrade">${icon('plus')}<span class="row-main">${
          now.funds.length ? L('Ander fonds gekocht', 'Bought another fund') : L('Aankoop invullen', 'Enter a purchase')}</span></button></li>
      </ul>
      <p class="group-note">${now.funds.length ? L('Tik op een fonds als je meer koopt of iets verkoopt.', 'Tap a fund when you buy more or sell some.')
        : L('Zoek het fonds dat je kocht en vul in hoeveel het er waren en wat je in totaal betaalde. Kassa rekent dan uit wat er nog niet belegd is.',
          'Search for the fund you bought and enter how many there were and what you paid in total. Kassa then works out what is not invested yet.')}</p>
      ${trades.length ? `
        <h2 class="section">${L('Aankopen en verkopen', 'Purchases and sales')}</h2>
        <ul class="group">${trades.map(tradeRow).join('')}</ul>
        <p class="group-note">${L('Het bedrag is met de kosten van de order; de prijs per stuk dus ook.', 'The amount includes the costs of the order, and so does the price per share.')}</p>` : ''}
      <h2 class="section split-head"><span>${L('Ingelegd', 'Invested')}</span><span>${formatEuro(now.put)}</span></h2>
      ${now.lines.length ? `<ul class="group">${now.lines.map((tx) => txRow(tx, catOf, { category: false })).join('')}</ul>` : ''}
      <p class="group-note">${L(`De bankregels in de categorie Beleggen; een regel naar DEGIRO (Flatex) komt er vanzelf in. Hoort er een niet bij: tik erop en
        kies een andere categorie. Mist er een: deel hem bij Transacties in als Beleggen.`,
      `The bank lines in the category Investing; a line to DEGIRO (Flatex) lands in it by itself. If one does not belong: tap it and
        choose another category. If one is missing: sort it as Investing in Transactions.`)}</p>
      ${stray.length ? `
        <ul class="group">${stray.map((tx) => txRow(tx, catOf)).join('')}</ul>
        <p class="group-note">${L('Van of naar DEGIRO, maar anders ingedeeld: dit telt niet mee als ingelegd.', 'From or to DEGIRO, but sorted as something else: this does not count as invested.')}</p>` : ''}
      <p class="group-note">${L(`De Kassa-server haalt de koersen elk uur op en ziet daardoor welke fondsen je hebt, niet hoeveel. Kosten buiten een order
        om en dividend kent Kassa niet: wat niet belegd is, kan daardoor op den duur iets afwijken van DEGIRO.`,
      `The Kassa server fetches the prices every hour and so sees which funds you hold, not how many. Kassa does not know costs outside an
        order or dividends: what is not invested may therefore drift a little from the figure at DEGIRO in time.`)}</p>`,
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
// Insight and a category show the month on screen or, with Jaar chosen, its whole year
const periodRange = () => (view.unit === 'year' ? [`${yearOf(view.month)}-01-01`, `${Number(yearOf(view.month)) + 1}-01-01`] : monthRange(view.month));
const periodStepper = () => (view.unit === 'year' ? stepper(yearOf(view.month), yearOf(view.month) >= yearOf(thisMonth())) : monthStepper());
const unitSwitch = () => `
  <div class="segments" role="group" aria-label="${L('Periode', 'Period')}">
    <button data-action="unit" data-id="month" aria-pressed="${view.unit !== 'year'}">${L('Maand', 'Month')}</button>
    <button data-action="unit" data-id="year" aria-pressed="${view.unit === 'year'}">${L('Jaar', 'Year')}</button>
  </div>`;

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

// One category in one month or year: what it cost, the months before (or of that year), who was paid, and every transaction.
// The id 'open' stands for everything that still has to be sorted, of all months together.
function categoryScreen(id) {
  const cat = catById(id);
  if (!cat && id !== 'open') return potsScreen();
  const yearly = cat && view.unit === 'year';
  const [from, to] = cat ? periodRange() : ['', '9999'];
  const txs = inCategory(bank, cat?.id ?? '', from, to);
  const catOf = sorter(bank);
  const sign = cat?.kind === 'in' ? 1 : -1; // spending is shown as a positive amount
  // Who the groceries were for, once any of them was for someone else. Under "Voor anderen" the others alone,
  // and one row for all that came out of the groceries, by card or by pin.
  const forOthers = cat?.id === 'anderen';
  const everyone = cat?.id === 'boodschappen' || forOthers ? forWhom(bank, state.purchases, from, to) : [];
  const who = forOthers ? everyone.filter(([name]) => name !== US) : everyone.some(([name]) => name !== US) ? everyone : [];
  const whoTotal = Math.max(1, who.reduce((sum, [, cents]) => sum + Math.max(0, cents), 0));
  // Groceries: a payment at the till is one row, the cards and the bank line of its pin part together, so it can
  // be split as one. That line is then not a row of its own, and under "Bij wie" it counts with the cards.
  const since = from > bank.since ? from : bank.since;
  const tills = cat?.id === 'boodschappen' ? state.purchases.filter((purchase) => (purchase.cards || purchase.tx) && dayOf(purchase) >= since && dayOf(purchase) < to) : [];
  const inTill = new Set(tills.map((purchase) => purchase.tx));
  const fromCards = !cat ? 0 : forOthers ? who.reduce((sum, [, cents]) => sum + cents, 0)
    : (figures({ ...bank, txs: [] }, state.purchases, from, to).byCat.get(cat.id) ?? 0) + txs.reduce((sum, tx) => sum - (inTill.has(tx.id) ? tx.cents : 0), 0);
  const total = !cat ? 0 : cat.kind === 'none' ? txs.reduce((sum, tx) => sum + tx.cents, 0) : (figures(bank, state.purchases, from, to).byCat.get(cat.id) ?? 0);
  const parties = byParty(txs.filter((tx) => !inTill.has(tx.id)));
  // the size of a bar: what was spent (or, for income, received); money the other way gets none. Unsorted money counts either way.
  const size = (party) => (cat && cat.kind !== 'none' ? Math.max(0, sign * party.cents) : Math.abs(party.cents));
  const whole = Math.max(1, fromCards + parties.reduce((sum, party) => sum + size(party), 0)); // the bars are shares of this
  const months = yearly ? chartMonths() : Array.from({ length: 6 }, (unused, index) => shiftMonth(view.month >= shiftMonth(thisMonth(), -5) ? thisMonth() : view.month, index - 5));
  const chosen = yearly ? '' : view.month; // in a year no month stands out; a tap on one opens that month
  const gifts = cat?.id === 'cadeaukaarten'; // everything here was paid to the shop that sells the cards: the shops the cards are for say more
  // a card sorted into another category still counts in what the cards bought and saved, so it is listed here too, with its category
  const elsewhere = gifts ? bank.txs.filter((tx) => tx.gift && tx.date >= since && tx.date < to && catOf(tx) !== cat.id) : [];
  const rows = [
    ...tills.map((purchase) => [dayOf(purchase), () => tillRow(purchase)]),
    ...txs.filter((tx) => !inTill.has(tx.id)).map((tx) => [tx.date, () => txRow(tx, catOf, { category: false, toFill })]),
    ...elsewhere.map((tx) => [tx.date, () => txRow(tx, catOf)]),
  ].sort((a, b) => b[0].localeCompare(a[0]));
  const shownRows = rows.slice(0, view.rows);
  const toFill = giftIds();
  return {
    html: `
      <header class="navbar">
        ${backButton()}
        <h1>${catName(cat?.id)}</h1>
        ${cat ? `<button class="text-button" data-action="editCat" data-id="${cat.id}">${L('Bewerken', 'Edit')}</button>` : '<span></span>'}
      </header>
      ${cat ? `
        ${unitSwitch()}
        <section class="summary period">
          ${periodStepper()}
          <p class="total">${cat.kind === 'none' ? signed(total) : formatEuro(total)}</p>
          ${cat.budget && !yearly ? `<ul class="plain">${potRow(cat, total, view.month).replace('<a class="row meter-row" href', '<a class="row meter-row bare" href')}</ul>` : ''}
          ${gifts ? flowChart(months, chosen, (month) => {
            const sum = giftSum(giftsBought(bank, ...monthRange(month)));
            return [sum.value - sum.paid, sum.value];
          }, [L('Bespaard', 'Saved'), L('Gekocht', 'Bought')])
          : cat.kind === 'none' ? '' : columnChart(months.map((month) => ({
            id: month, name: monthName(month), short: monthShort(month), total: Math.max(0, monthFigures(month).byCat.get(cat.id) ?? 0), chosen: month === chosen,
          })), 'pickMonth', yearly ? 'flow' : '')}
        </section>`
      : `<p class="group-note">${L('Tik op een naam en kies een categorie. Alles van die naam gaat dan mee, ook wat later binnenkomt.',
        'Tap a name and choose a category. Everything from that name follows, including what comes in later.')}</p>`}
      ${who.length ? `
        <h2 class="section">${L('Voor wie', 'For whom')}</h2>
        <ul class="group">${who.map(([name, cents]) => `
          <li class="row meter-row"><span class="row-main">${esc(shown(name))}</span>
            <span>${formatEuro(cents)}</span>${meterBar(Math.max(0, cents) / whoTotal, { rank: true })}</li>`).join('')}</ul>` : ''}
      ${gifts ? `${fillRow() && `<div class="group">${fillRow()}</div>`}${giftSections(from, to)}` : ''}
      ${rows.length || fromCards ? `
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
        <ul class="group">${shownRows.map(([, row]) => row()).join('')}</ul>
        ${rows.length > shownRows.length ? `<div class="group"><button class="row tint" data-action="moreRows">${L('Toon meer', 'Show more')}</button></div>` : ''}
        ${cat?.id === 'boodschappen' ? `<p class="group-note">${L('Was iets, of een deel ervan, voor iemand anders? Tik op de transactie en kies Voor wie. Wat je bij AH met cadeaukaarten en pin betaalde, staat hier als één aankoop.',
          'Was something, or part of it, for someone else? Tap the transaction and choose For whom. What you paid at AH with gift cards and debit card is one purchase here.')}</p>` : ''}
        ${gifts ? `<p class="group-note">${L(`Een kaart van ${AH}, of van een winkel waarvan je het saldo bijhoudt, telt hier niet mee: het geld telt als uitgave zodra je ermee betaalt. Een kaart die je in een andere categorie zet, telt daar als uitgave; wat hij bespaarde blijft hierboven meetellen.`,
          `A card for ${AH}, or for a shop whose balance you keep, does not count here: the money counts as spending once you pay with it. A card you sort into another category counts as spending there; what it saved stays in the figures above.`)}</p>` : ''}`
      : blank(!cat ? L('Alles is ingedeeld', 'Everything is sorted') : yearly ? L('Niets in dit jaar', 'Nothing this year') : L('Niets in deze maand', 'Nothing this month'))}`,
  };
}

// 'ma', 'di' … in Dutch, 'Mon', 'Tue' … in English
const weekday = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString(LOCALE, { weekday: 'short', timeZone: 'UTC' }).replace('.', '');

// The fixed costs of a month as a calendar, each on the day it went out or usually goes out, and then in words:
// what was not charged on the day it usually is and is still open, what is still to come week by week, and what
// went out. When a bank charges later (a weekend, a holiday) nothing is guessed: it stays open until it is there.
function fixedScreen() {
  const month = view.month;
  const { costs, total, waiting } = fixedSummary(month);
  const today = isoDate();
  const open = month === thisMonth();
  const catOf = sorter(bank);
  const suggestions = fixedSuggestions(bank, thisMonth());
  const items = costs.map((cost) => ({
    ...cost, date: cost.on || expectedOn(cost, month), state: cost.on ? 'paid' : expectedOn(cost, month) < today ? 'late' : 'due',
    tx: cost.on ? bank.txs.find((tx) => tx.date === cost.on && tx.cents < 0 && ruleKey(tx.name) === cost.key) : lastPaid(cost.key),
  })).sort((a, b) => a.date.localeCompare(b.date));
  const [paid, late, due] = ['paid', 'late', 'due'].map((state) => items.filter((item) => item.state === state));
  const sum = (list) => list.reduce((cents, item) => cents + (item.paid || item.expected), 0);
  const note = (item) => {
    const cat = catName(catOf(item.tx));
    if (item.state === 'paid') {
      return `${L('Betaald', 'Paid')}${item.expected && item.paid !== item.expected ? ` · ${L('de keer ervoor', 'last time')} ${formatEuro(item.expected)}` : ''} · ${cat}`;
    }
    if (item.state === 'late') {
      return open ? L(`Verwacht op ${dayShort(item.date)}, staat nog open`, `Expected on ${dayShort(item.date)}, still pending`)
        : L(`Verwacht op ${dayShort(item.date)}`, `Expected on ${dayShort(item.date)}`);
    }
    const days = daysLeft(item.date, today);
    return `${days === 0 ? L('Vandaag verwacht', 'Expected today') : days === 1 ? L('Morgen', 'Tomorrow') : L(`Over ${days} dagen`, `In ${days} days`)} · ${cat}`;
  };
  const row = (item) => `
    <li><button class="row" data-action="tx" data-id="${esc(item.tx.id)}">
      <span class="date-badge ${item.state}${item.state === 'due' && item.date === today ? ' today' : ''}"><b>${Number(item.date.slice(8))}</b>${weekday(item.date)}</span>
      <span class="row-main">${esc(item.name)} <small>${note(item)}</small></span>
      <span class="amount${item.state === 'paid' ? '' : ' quiet'}">${formatEuro(item.paid || item.expected)}</span>
    </button></li>`;
  const list = (title, each) => (each.length ? `
    <h2 class="section split-head"><span>${title}</span><span>${formatEuro(sum(each))}</span></h2>
    <ul class="group dated">${each.map(row).join('')}</ul>` : '');
  // what is still to come, by week from Monday; the rest of the month after next week is one group
  const sinceMonday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const week = (item) => Math.min(2, Math.floor((daysLeft(item.date, today) + sinceMonday) / 7));
  const weeks = [L('Deze week', 'This week'), L('Volgende week', 'Next week'), L('Later deze maand', 'Later this month')]
    .map((title, index) => list(title, due.filter((item) => week(item) === index))).join('');
  // the calendar, Monday first; a day shows the state that needs the most attention, a dot per payment
  const first = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
  const days = Array.from({ length: daysIn(month) }, (unused, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    const here = items.filter((item) => item.date === date);
    const state = ['late', 'due', 'paid'].find((each) => here.some((item) => item.state === each));
    const kind = [state, (first + index) % 7 >= 5 && 'weekend', date === today && 'today'].filter(Boolean).join(' ');
    return `<li${kind ? ` class="${kind}"` : ''}><b>${index + 1}</b><span class="dots">${here.map((item) => `<i class="${item.state}"></i>`).join('')}</span></li>`;
  });
  const whole = total + waiting;
  return {
    html: `
      <header class="navbar">${backButton()}<h1>${L('Vaste lasten', 'Fixed costs')}</h1><span></span></header>
      <section class="summary">
        ${monthStepper()}
        ${costs.length ? `
          <div class="pair fixed-pair">
            <div><p class="tile-total">${formatEuro(total)}</p><p class="footnote">${L('Betaald', 'Paid')} · ${paid.length}</p></div>
            ${waiting ? `<div><p class="tile-total">${formatEuro(waiting)}</p>
              <p class="footnote">${open ? L('Nog te gaan', 'Still to go') : L('Niet afgeschreven', 'Not charged')} · ${late.length + due.length}</p></div>` : ''}
          </div>
          <svg class="fixed-bar" aria-hidden="true"><rect class="track" width="100%" height="100%" rx="4"/>
            <rect class="late" width="${((total + sum(late)) / whole * 100).toFixed(1)}%" height="100%" rx="4"/>
            <rect class="paid" width="${(total / whole * 100).toFixed(1)}%" height="100%" rx="4"/></svg>` : ''}
      </section>
      ${costs.length ? `
        <div class="cal" aria-hidden="true">
          <ol class="cal-head">${Array.from({ length: 7 }, (unused, index) => `<li>${weekday(`2024-01-0${index + 1}`)}</li>`).join('')}</ol>
          <ol class="cal-days">${'<li></li>'.repeat(first)}${days.join('')}</ol>
          <p class="legend"><span><i class="key k-paid"></i>${L('Betaald', 'Paid')}</span><span><i class="key k-late"></i>${L('Niet afgeschreven', 'Not charged')}</span>${
            open ? `<span><i class="key k-due"></i>${L('Komt nog', 'Still to come')}</span>` : ''}</p>
        </div>
        ${list(open ? L('Nog niet afgeschreven', 'Not charged yet') : L('Niet afgeschreven', 'Not charged'), late)}
        ${weeks}
        ${list(L('Betaald', 'Paid'), paid)}`
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

const daysIn = (month) => new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
// the end of the first `day` days of `month`, as the `to` of figures(); a shorter month is over sooner
const afterDay = (month, day) => (day < daysIn(month) ? `${month}-${String(day + 1).padStart(2, '0')}` : `${shiftMonth(month, 1)}-01`);
// whole euros: a forecast or a difference is no more exact than that
const wholeEuro = (cents) => (cents < 0 ? `− ${wholeEuro(-cents)}`
  : Math.round(cents / 100).toLocaleString(LOCALE, { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 }));
// a difference in spending as a label: more in red, less in green, within a euro grey
function change(cents, text) {
  const euros = Math.round(cents / 100);
  return `<span class="change${euros > 0 ? ' more' : euros < 0 ? ' less' : ''}">${text
    ?? (euros ? `${euros > 0 ? '+' : '−'} ${wholeEuro(Math.abs(cents))}` : L('gelijk', 'same'))}</span>`;
}

// The running month added up day by day, and the month before as a dashed line beside it. From today two lines go
// on to the end of the month: what is sure (`coming`: the fixed costs and planned payments still to come, each
// on its day; one that is late tomorrow) and, dotted and above it, the forecast, which adds `rate` cents for
// every day. `past` is the bank data the month before is read from.
function paceChart(month, day, coming, rate, past) {
  const before = shiftMonth(month, -1);
  const days = daysIn(month);
  const added = (each, last, data) => Array.from({ length: last }, (unused, index) => figures(data, state.purchases, `${each}-01`, afterDay(each, index + 1)).spending);
  const now = added(month, day, bank);
  const then = `${before}-01` >= bank.since ? added(before, daysIn(before), past) : [];
  const sure = Array.from({ length: days - day + 1 }, (unused, index) => now.at(-1)
    + coming.filter((each) => Math.max(Number(each.date.slice(8)), day + 1) <= day + index).reduce((sum, each) => sum + each.cents, 0));
  const ahead = sure.map((cents, index) => cents + Math.round(rate * index));
  const top = Math.max(100, ahead.at(-1), ...now, ...then) * 1.08;
  const step = [5000, 10000, 20000, 50000, 100000, 200000, 500000].find((each) => top / each <= 3) ?? 1000000;
  const x = (nth) => (4 + (nth - 1) / 30 * 280).toFixed(1);
  const y = (cents) => (160 - cents / top * 144).toFixed(1);
  const line = (list, first = 1) => list.map((cents, index) => `${x(index + first)},${y(cents)}`).join(' ');
  const grid = Array.from({ length: Math.floor(top / step) }, (unused, index) => (index + 1) * step);
  const compact = (cents) => (cents / 100).toLocaleString(LOCALE, { style: 'currency', currency: 'EUR', notation: 'compact' });
  const last = then.length ? `, ${wholeEuro(then.at(-1))} ${L('in', 'in')} ${monthName(before)}` : '';
  return `
    <svg class="pace" viewBox="0 0 320 180" role="img" aria-label="${L(`Uitgegeven, per dag opgeteld: ${wholeEuro(now.at(-1))} tot nu, aan het eind van de maand zeker ${wholeEuro(sure.at(-1))} en verwacht ${wholeEuro(ahead.at(-1))}${last}`,
      `Spending added up per day: ${wholeEuro(now.at(-1))} so far, ${wholeEuro(sure.at(-1))} for sure and ${wholeEuro(ahead.at(-1))} forecast by the end of the month${last}`)}">
      ${grid.map((cents) => `<line class="grid" x1="4" x2="288" y1="${y(cents)}" y2="${y(cents)}"/>
        <text x="318" y="${(Number(y(cents)) + 4).toFixed(1)}" text-anchor="end">${compact(cents)}</text>`).join('')}
      <line class="base" x1="4" x2="288" y1="160" y2="160"/>
      ${then.length ? `<polyline class="then" points="${line(then)}"/>` : ''}
      <path class="area" d="M${x(1)} 160L${line(now).replaceAll(' ', 'L')}L${x(day)} 160Z"/>
      <polyline class="stroke" points="${line(now)}"/>
      <polyline class="sure" points="${line(sure, day)}"/>
      <polyline class="ahead" points="${line(ahead, day)}"/>
      <line class="rule" x1="${x(day)}" x2="${x(day)}" y1="10" y2="160"/>
      <circle class="dot" cx="${x(day)}" cy="${y(now.at(-1))}" r="5"/>
      <circle class="end" cx="${x(days)}" cy="${y(sure.at(-1))}" r="3"/>
      <circle class="end" cx="${x(days)}" cy="${y(ahead.at(-1))}" r="4"/>
    </svg>
    <p class="axis"><span>${dayShort(`${month}-01`)}</span><span>${dayShort(`${month}-${days}`)}</span></p>
    <p class="legend"><span><i class="key now"></i>${L('Deze maand', 'This month')}</span><span><i class="key sure"></i>${L('Zeker', 'For sure')} ${wholeEuro(sure.at(-1))}</span><span><i class="key ahead"></i>${L('Verwacht', 'Forecast')} ${wholeEuro(ahead.at(-1))}</span>${
      then.length ? `<span><i class="key then"></i>${monthShort(before)} ${wholeEuro(then.at(-1))}</span>` : ''}</p>`;
}

function insightScreen() {
  const yearly = view.unit === 'year';
  const [from, to] = periodRange();
  const now = figures(bank, state.purchases, from, to);
  const left = now.income - now.spending;
  const short = left < 0 && to <= isoDate(); // only a period that is over can end short
  const kinds = new Map(bank.cats.map((cat) => [cat.id, cat.kind]));
  const spent = [...now.byCat].filter(([id, cents]) => (kinds.get(id) ?? (cents > 0 ? 'out' : '')) === 'out' && cents > 0).sort((a, b) => b[1] - a[1]);
  const earned = [...now.byCat].filter(([id]) => kinds.get(id) === 'in').sort((a, b) => b[1] - a[1]);
  // A running month is held against the same first days of the three months before; a month that is over, against them whole.
  const running = !yearly && view.month === thisMonth();
  const day = Number(isoDate().slice(8));
  const days = daysIn(view.month);
  const open = running && day < days; // days are left: the rest of the month has something to say
  const before = [1, 2, 3].map((back) => shiftMonth(view.month, -back));
  // the months before are read without what is over: a loan that is paid off says nothing about a month now
  const over = ended(bank, view.month);
  const past = over.size ? { ...bank, txs: bank.txs.filter((tx) => !over.has(ruleKey(tx.name))) } : bank;
  const whole = before.map((month) => figures(past, state.purchases, ...monthRange(month)));
  const sofar = before.map((month, index) => (running ? figures(past, state.purchases, `${month}-01`, afterDay(month, day)) : whole[index]));
  const known = (index) => `${before[index]}-01` >= bank.since && whole[index].spending > 0; // in the data from its first day
  const usual = !yearly && [0, 1, 2].every(known) ? (id) => average(sofar.map((each) => Math.max(0, each.byCat.get(id) ?? 0))) : null;
  const average3 = usual ? average(whole.map((each) => each.spending)) : 0;
  let versus = '';
  if (!yearly && known(0)) {
    const diff = now.spending - sofar[0].spending;
    const date = new Date(`${before[0]}-${String(Math.min(day, daysIn(before[0]))).padStart(2, '0')}`)
      .toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', timeZone: 'UTC' });
    const month = monthDate(before[0]).toLocaleDateString(LOCALE, { month: 'long' });
    const [nl, en] = running ? [`op ${date}`, `by ${date}`] : [`in ${month}`, `in ${month}`];
    versus = `<p class="center versus">${change(diff, Math.round(diff / 100) === 0 ? L(`Evenveel als ${nl}`, `The same as ${en}`)
      : L(`${wholeEuro(Math.abs(diff))} ${diff > 0 ? 'meer' : 'minder'} dan ${nl}`, `${wholeEuro(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than ${en}`))}</p>`;
  }
  const { fixed, due, coming, waiting, sure, rate, ahead } = outlook(view.month, now.spending, open);
  const salary = running ? salaryCard(view.month, now, { waiting, sure, ahead }) : '';
  const fixedRow = !yearly && fixed.costs.length ? `
    <a class="row" href="#/vast"><span class="row-main">${L('Vaste lasten', 'Fixed costs')} <small>${fixed.text}</small></span>
      <span class="amount">${formatEuro(fixed.total)}</span>${icon('next')}</a>` : '';
  const daysLeft = days - day;
  const room = average3 - sure; // what may still go out and stay under the average
  // From what was left to what the net worth did. Money that only moved is not spending, but a loan repaid or
  // money sent to an account the app does not hold did leave the accounts; the rest is the gift cards (a card
  // is worth more than it cost, and balance can be added or corrected by hand).
  const worthWas = worthOn(dayBefore(from > bank.since ? from : bank.since));
  const worthIs = worthOn(dayBefore(to));
  const moves = bank.cats.filter((cat) => cat.kind === 'none').map((cat) => [cat, now.moved.get(cat.id) ?? 0]).filter(([, cents]) => cents);
  const cardGain = worthIs - worthWas - left - moves.reduce((sum, [, cents]) => sum + cents, 0);
  // net worth at the end of each month; the running month stands at today. The chart marks a month tapped on it, else the month on screen.
  const points = chartMonths().map((month) => ({ id: month, name: monthShort(month), cents: worthOn(month === thisMonth() ? '9999' : `${month}-31`) }));
  const worthMonth = [view.worth, view.month].find((month) => points.some((point) => point.id === month)) ?? points.at(-1)?.id;
  const links = (open ? '' : fixedRow) + savedRow(from, to); // a running month shows the fixed costs with what is still to come
  if (!bank.accounts.length) {
    return { html: `<header class="large-title"><h1>${L('Inzicht', 'Insight')}</h1></header>
      ${blank(L('Nog niets te zien', 'Nothing to see yet'), L('Upload eerst je bankbestanden op Overzicht.', 'Upload your bank files on Overview first.'))}` };
  }
  return {
    html: `
      <header class="large-title"><h1>${L('Inzicht', 'Insight')}</h1></header>
      ${unitSwitch()}
      <section class="summary period">
        ${periodStepper()}
        <dl class="trio">
          <div><dt>${L('In', 'In')}</dt><dd>${formatEuro(now.income)}</dd></div>
          <div><dt>${running ? L('Uit tot nu', 'Out so far') : L('Uit', 'Out')}</dt><dd>${formatEuro(now.spending)}</dd></div>
          <div><dt>${left < 0 ? L('Tekort', 'Short') : L('Over', 'Left')}</dt><dd class="${short ? 'over-text' : ''}">${formatEuro(Math.abs(left))}</dd></div>
        </dl>
        ${now.income > 0 && left > 0 ? `<p class="footnote center">${Math.round(left / now.income * 100)}% ${L('van wat binnenkwam bleef over', 'of what came in was left')}</p>` : ''}
        ${versus}
        ${!yearly && fixed.total > 0 && now.spending > 0 ? `
          <div class="split">
            ${meterBar(fixed.total / now.spending)}
            <p class="legend"><span><i class="key fixed"></i>${L('Vaste lasten', 'Fixed costs')} ${formatEuro(fixed.total)}</span>
              <span><i class="key rest"></i>${L('De rest', 'The rest')} ${formatEuro(Math.max(0, now.spending - fixed.total))}</span></p>
          </div>` : ''}
        ${flowChart(chartMonths(), yearly ? '' : view.month)}
      </section>
      ${salary && `<h2 class="section">${L('Salaris', 'Salary')}</h2>${salary}`}
      ${open ? `
        <h2 class="section split-head"><span>${L('Rest van de maand', 'Rest of the month')}</span>
          <span>${daysLeft === 1 ? L('nog 1 dag', '1 day left') : L(`nog ${daysLeft} dagen`, `${daysLeft} days left`)}</span></h2>
        <section class="summary">
          <h3 class="chart-title">${L('Uitgegeven tot nu, per dag opgeteld', 'Spent so far, added up per day')}</h3>
          ${paceChart(view.month, day, coming, rate, past)}
        </section>
        <div class="tiles">
          <section class="tile">
            <h3>${L('Verwacht', 'Forecast')}</h3>
            <p class="tile-total">${wholeEuro(ahead)}</p>
            <p class="footnote">${L(`uitgegeven op ${dayShort(`${view.month}-${days}`)}, waarvan ${wholeEuro(sure)} zeker`, `spent by ${dayShort(`${view.month}-${days}`)}, ${wholeEuro(sure)} of it for sure`)}</p>
            ${average3 ? `<p class="tile-note ${ahead > average3 ? 'over-text' : 'plus'}">${ahead > average3
              ? L(`${wholeEuro(ahead - average3)} boven je gemiddelde`, `${wholeEuro(ahead - average3)} over your average`)
              : L(`${wholeEuro(average3 - ahead)} onder je gemiddelde`, `${wholeEuro(average3 - ahead)} under your average`)}</p>` : ''}
          </section>
          ${!average3 ? '' : room > 0 ? `
            <section class="tile">
              <h3>${L('Onder je gemiddelde blijven', 'Stay under your average')}</h3>
              <p class="tile-total">${wholeEuro(room / daysLeft)} <small>${L('per dag', 'a day')}</small></p>
              <p class="footnote">${daysLeft === 1 ? L('voor de laatste dag', 'for the last day') : L(`voor de ${daysLeft} dagen die over zijn`, `for the ${daysLeft} days left`)}${
                waiting ? L(', na wat nog komt', ', after what is still to come') : ''}</p>
            </section>` : `
            <section class="tile">
              <h3>${L('Boven je gemiddelde', 'Over your average')}</h3>
              <p class="tile-total over-text">${wholeEuro(-room)}</p>
              <p class="footnote">${waiting ? L('al, met wat nog komt', 'already, with what is still to come') : L('al, deze maand', 'already, this month')}</p>
            </section>`}
        </div>
        <p class="group-note">${L(`Zeker is wat er al uit is plus wat nog komt: je vaste lasten en wat je hebt gepland. De verwachting telt daar ${wholeEuro(rate)} per dag bij op: je kleine uitgaven (onder ${wholeEuro(LARGE)}), in het tempo van deze maand en de drie ervoor. Wanneer de volgende grote uitgave komt is uit eerdere maanden niet te voorspellen, dus die telt pas mee als je haar plant.`,
          `For sure is what went out already plus what is still to come: your fixed costs and what you planned. The forecast adds ${wholeEuro(rate)} a day to that: your small purchases (under ${wholeEuro(LARGE)}), at the pace of this month and the three before. When the next large purchase comes cannot be told from earlier months, so it only counts once you plan it.`)}${
          average3 ? ` ${L('Je gemiddelde is wat er de drie maanden ervoor gemiddeld uitging.', 'Your average is what went out on average in the three months before.')}` : ''}${
          over.size ? ` ${L('Een vaste last die is gestopt telt in de maanden ervoor niet mee.', 'A fixed cost that has stopped is left out of the months before.')}` : ''}</p>
        <h2 class="section split-head"><span>${L('Wat nog komt', 'Still to come')}</span><span>${formatEuro(waiting)}</span></h2>
        <ul class="group">${due.map(dueRow).join('')}
          <li><button class="row tint" data-action="plan">${L('Betaling plannen', 'Plan a payment')}</button></li>
          ${fixedRow && `<li>${fixedRow}</li>`}
        </ul>` : ''}
      ${spent.length ? `
        <h2 class="section split-head"><span>${L('Uitgaven per categorie', 'Spending per category')}</span>${usual ? `<span>${L('t.o.v. normaal', 'vs usual')}</span>` : ''}</h2>
        <ul class="group">${spent.map(([id, cents]) => `
          <li><a class="row meter-row" href="#/categorie/${id || 'open'}">
            <span class="row-main${id ? '' : ' todo'}">${catName(id)} <small class="inline">${Math.round(cents / now.spending * 100)}%</small></span>
            <span class="meter-end">${usual && id ? change(cents - usual(id)) : ''}${formatEuro(cents)}</span>
            ${meterBar(cents / now.spending, { rank: true })}
          </a></li>`).join('')}</ul>
        ${usual ? `<p class="group-note">${running
          ? L(`Normaal is wat je in de eerste ${day} dagen uitgaf, gemiddeld over de drie maanden ervoor.`, `Usual is what you spent in the first ${day} days, on average over the three months before.`)
          : L('Normaal is het gemiddelde van de drie maanden ervoor.', 'Usual is the average of the three months before.')}</p>` : ''}` : ''}
      ${links && `<div class="group">${links}</div>`}
      ${earned.length ? `
        <h2 class="section">${L('Inkomen', 'Income')}</h2>
        <ul class="group">${earned.map(([id, cents]) => `
          <li><a class="row" href="#/categorie/${id}"><span class="row-main">${catName(id)}</span><span class="amount">${formatEuro(cents)}</span>${icon('next')}</a></li>`).join('')}</ul>` : ''}
      ${points.length || moves.length || cardGain ? `<h2 class="section" id="vermogen">${L('Vermogen', 'Net worth')}</h2>` : ''}
      ${points.length ? `
        <section class="summary worth">
          <p class="footnote">${worthMonth === thisMonth() ? L('Nu', 'Now') : `${L('Eind', 'End of')} ${monthName(worthMonth)}`}</p>
          <p class="total small">${formatEuro(points.find((point) => point.id === worthMonth).cents)}</p>
          ${lineChart(points, worthMonth, 'pickWorth')}
        </section>` : ''}
      ${moves.length || cardGain ? `
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
      ${points.length ? `
        <ul class="group">
          ${bank.accounts.map((account) => `<li class="row"><span class="row-main">${esc(nameOf(account))}</span>
            <span class="amount">${formatEuro(balanceOn(bank, account, worthMonth === thisMonth() ? '9999' : `${worthMonth}-31`))}</span></li>`).join('')}
          <li class="row"><span class="row-main">${L('Cadeaukaarten', 'Gift cards')}</span>
            <span class="amount">${formatEuro(cardsOn(state.cards, worthMonth === thisMonth() ? '9999' : `${worthMonth}-31`))}</span></li>
        </ul>` : ''}
      ${investInsight(chartMonths(), yearly ? yearOf(view.month) : view.month)}
      <div class="period-bar" aria-hidden="true">${periodStepper().replaceAll('<button', '<button tabindex="-1"')}</div>`,
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
    .reverse().sort((a, b) => b.date.localeCompare(a.date)); // within a day too the newest on top: the last added
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
      : syncError ? L('Geen verbinding met de Kassa-server: wat je nu wijzigt, wordt niet bewaard.',
        'No connection with the Kassa server: what you change now is not saved.')
        : L('Alles is bijgewerkt.', 'Everything is up to date.');
  return `
    <h2 class="section">${L('Samen delen', 'Sharing')}</h2>
    <div class="group">
      <button class="row tint" data-action="invite">${L('Iemand uitnodigen', 'Invite someone')}</button>
      <button class="row tint" data-action="syncNow">${L('Nu bijwerken', 'Update now')}</button>
    </div>
    <p class="group-note" aria-live="polite">${status} ${L('Alles staat op de Kassa-server, niet op deze telefoon: elke wijziging gaat er meteen heen. Zolang Kassa open is, zie je binnen tien seconden wat de ander wijzigt.',
      'Everything is on the Kassa server, not on this phone: every change goes there at once. While Kassa is open, you see what the other phone changes within ten seconds.')}</p>`;
}

// Only with sharing on: the server lets in only phones of the household.
function bankSection() {
  if (!sharing) return '';
  const time = links.ok ? `${formatDate(links.ok)}, ${new Date(links.ok).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}` : '';
  const linked = Object.entries(links.banks).map(([name, until]) => (links.failed.includes(name)
    ? L(`${name} gekoppeld tot ${formatDate(until)}; ophalen lukte de laatste keer niet.`, `${name} linked until ${formatDate(until)}; fetching failed the last time.`)
    : L(`${name} gekoppeld tot ${formatDate(until)}.`, `${name} linked until ${formatDate(until)}.`))).join(' ');
  return `
    <div class="group">
      <button class="row tint" data-action="fetchBank">${L('Nu ophalen bij de bank', 'Fetch from the bank now')}</button>
      ${Object.keys(LINKABLE).map((name) => `<button class="row tint" data-action="linkBank" data-id="${name}">${links.banks[name]
        ? L(`${name} opnieuw koppelen`, `Link ${name} again`) : L(`${name} koppelen`, `Link ${name}`)}</button>`).join('')}
    </div>
    <p class="group-note">${linked || L('Koppel je rekeningen: dan haalt Kassa nieuwe transacties zelf op als je de app opent.',
      'Link your accounts: Kassa then fetches new transactions itself when you open the app.')} ${time ? L(`Laatst opgehaald ${time}.`, `Last fetched ${time}.`) : ''}
      ${L('Elke 180 dagen (Trade Republic: 90) keur je een koppeling opnieuw goed in de app van de bank. De transacties gaan via de Kassa-server en Enable Banking, die ze kunnen lezen.',
        'Every 180 days (Trade Republic: 90) you approve a link again in the bank\'s app. The transactions pass through the Kassa server and Enable Banking, which can read them.')}</p>`;
}

function pushSection() {
  if (!sharing) return '';
  const on = Boolean(localStorage.getItem(PUSH_KEY));
  const can = standalone && 'PushManager' in window;
  return `
    <h2 class="section">${L('Meldingen', 'Notifications')}</h2>
    ${can ? `<div class="group"><button class="row tint" data-action="${on ? 'pushOff' : 'pushOn'}">${on ? L('Meldingen uitzetten', 'Turn notifications off')
      : L('Meldingen aanzetten', 'Turn notifications on')}</button></div>` : ''}
    <p class="group-note">${can ? '' : L('Meldingen werken alleen in Kassa op je beginscherm. ', 'Notifications only work in Kassa on your Home Screen. ')}${L(
      `Per telefoon: nieuwe banktransacties (tot vier keer per dag), wijzigingen op de andere telefoon (hooguit één keer per uur),
      een afgesloten maand met wat er uitging en binnenkwam, een herinnering zolang een maand nog bestanden mist, en het aflopen van een
      bankkoppeling. Daarvoor gaan de maandtotalen en de namen van de rekeningen naar de Kassa-server.`,
      `Per phone: new bank transactions (up to four times a day), changes on the other phone (at most once an hour), a closed month
      with what went out and came in, a reminder while a month still misses files, and the end of a bank link. For this, the
      monthly totals and the account names go to the Kassa server.`)}</p>`;
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
      <p class="group-note">${L(`Kies één of meer bestanden: het CSV-bestand van een Rabo-rekening, het CSV- of PDF-bestand van een Rabo-creditcard, of het PDF-afschrift van Openbank.
        Bestanden mogen elkaar overlappen: wat er al staat, komt er niet nog eens bij.`, `Choose one or more files: the CSV file of a Rabo account, the CSV or
        PDF file of a Rabo credit card, or the PDF statement from Openbank. Files may overlap: what is already there is not added again.`)}</p>
      ${bankSection()}
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
      ${pushSection()}
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

// With sharing on, the data comes from the server only: until it is in, there is nothing to show.
const waitScreen = () => ({
  html: `
    <section class="install">
      <img src="icon-180.png" alt="" width="88" height="88">
      <h1>${syncError ? L('Geen verbinding met de Kassa-server', 'No connection with the Kassa server') : L('Gegevens ophalen…', 'Fetching your data…')}</h1>
      ${syncError ? `<p>${L('Je gegevens staan veilig op de server. Kassa probeert het elke tien seconden opnieuw.', 'Your data is safe on the server. Kassa tries again every ten seconds.')}</p>
      <div class="group"><button class="row tint" data-action="syncNow">${L('Nu opnieuw proberen', 'Try again now')}</button></div>` : ''}
    </section>`,
});

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

// Ends a payment with the cards that were used, the last one last. Was everything paid with them, then the total
// says what the last card has left, and who it was for is asked. Was the rest paid by pin, then every card is empty
// and nothing has to be typed at the till: the bank line of the pin part joins the purchase by itself once it is
// there (bank.js, tie), and with it the total is known.
async function finishPayment(cards) {
  if (!cards.length) {
    toast(L('Geen kaart gebruikt: er is niets vastgelegd.', 'No card used: nothing was recorded.'));
    goCards();
    return;
  }
  const balances = cards.map(balance);
  const held = balances.reduce((sum, cents) => sum + cents, 0);
  const earlier = held - balances.at(-1);
  const answer = await confirmWith(`${cards.length === 1 ? L(`Kaart ${last4(cards[0])} met ${formatEuro(held)}.`, `Card ${last4(cards[0])} with ${formatEuro(held)}.`)
    : L(`${cards.length} kaarten met samen ${formatEuro(held)}.`, `${cards.length} cards with ${formatEuro(held)} together.`)} ${
    L('Is alles met cadeaukaarten betaald?', 'Was everything paid with gift cards?')}`,
  L('Ja, alles met cadeaukaarten', 'Yes, all with gift cards'), true, L('Nee, ook gepind', 'No, by debit card too'));
  if (!answer) return;
  const wait = answer === 'alt';
  // a total above what the cards held is fine too: then the rest was pin after all, and the amount is known
  const total = wait ? held : await askAmount(L('Afronden', 'Finish'), L('Totaalbedrag van de bon', 'Total on the receipt'), (cents) => {
    if (settle(balances, cents) !== 'low') return '';
    return earlier
      ? L(`Dat dekten de vorige kaarten al (${formatEuro(earlier)}). Ga terug met Vorige.`,
        `The previous cards already covered that (${formatEuro(earlier)}). Go back with Previous.`)
      : ENTER_AMOUNT;
  });
  if (total === null) return;
  const taken = settle(balances, total);
  const fromCards = taken.reduce((sum, cents) => sum + cents, 0);
  const purchase = { ...newPurchase('AH', total, fromCards), ...(wait && { wait }) };
  cards.forEach((card, index) => card.entries.push({ ...newEntry('pay', -taken[index]), purchase: purchase.id }));
  state.purchases.push(purchase);
  save();
  const from = L(`${formatEuro(fromCards)} van ${plural(cards.length, 'kaart', 'kaarten')}`, `${formatEuro(fromCards)} from ${plural(cards.length, 'card', 'cards')}`);
  toast(wait ? L(`${from}. De pinbetaling komt erbij zodra de bank hem laat zien.`, `${from}. The debit card payment joins once the bank shows it.`)
    : total > fromCards ? L(`${formatEuro(fromCards)} met kaarten, ${formatEuro(total - fromCards)} met pin.`,
      `${formatEuro(fromCards)} by gift card, ${formatEuro(total - fromCards)} by debit card.`)
    : `${from}.`);
  goCards();
  if (!wait) askWho(purchase); // while the pin part is to come there is no total to split yet: that is done on the purchase
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

// One purchase at the till with everything it was paid with: each card and what it cost at the time, and the bank
// line of the pin part. It is reached from the groceries and from the till payments, so back goes where it came from.
function purchaseScreen(purchase) {
  const day = new Date(purchase.at).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const line = bank.txs.find((tx) => tx.id === purchase.tx);
  const pin = purchase.total - purchase.cards;
  const used = state.cards.flatMap((card) => card.entries.filter((entry) => entry.purchase === purchase.id).map((entry) => ({ card, cents: -entry.delta })));
  const gone = purchase.cards - used.reduce((sum, each) => sum + each.cents, 0); // paid with a card that was deleted since
  // what the card cost: its part of the payment that bought it, which may have bought more cards
  const cost = (card) => {
    const paid = bank.txs.find((tx) => tx.id === card.tx && tx.gift);
    const start = card.entries[0]?.delta;
    return paid && start > 0 ? ` <small>${formatEuro(start)} ${L('gekocht voor', 'bought for')} ${formatEuro(Math.round(-paid.cents * start / paid.gift.value))}</small>` : '';
  };
  return {
    html: `
      <header class="navbar">
        ${backButton()}
        <h1>${esc(shown(purchase.store))}</h1>
        <button class="text-button" data-action="editPurchase">${L('Bewerken', 'Edit')}</button>
      </header>
      <section class="summary">
        <p class="footnote">${day}</p>
        <p class="total">${formatEuro(purchase.total)}</p>
        ${purchase.wait ? `<p class="footnote">${L('zonder wat je pinde: dat komt erbij zodra de bank het laat zien', 'without what went by debit card: that joins once the bank shows it')}</p>` : ''}
      </section>
      <h2 class="section">${L('Voor wie', 'For whom')}</h2>
      <div class="group">
        ${purchase.shares.map((share) => `
          <p class="row"><span class="row-main">${esc(shown(share.who))}</span>${formatEuro(share.cents)}</p>`).join('')}
        <button class="row tint" data-action="who">${L('Wijzigen', 'Change')}</button>
      </div>
      <h2 class="section">${L('Betaald met', 'Paid with')}</h2>
      <div class="group">
        ${used.map(({ card, cents }) => `
          <p class="row"><span class="row-main">${L('Kaart', 'Card')} ${last4(card)}${cost(card)}</span>${formatEuro(cents)}</p>`).join('')}
        ${gone > 0 ? `<p class="row"><span class="row-main">${L('Cadeaukaarten', 'Gift cards')}</span>${formatEuro(gone)}</p>` : ''}
        ${purchase.wait ? `<p class="row"><span class="row-main">${L('Pin', 'Debit card')} <small>${L('Nog niet bij de bank', 'Not at the bank yet')}</small></span><span class="quiet">…</span></p>
          <button class="row tint" data-action="noPin">${L('Er is niet gepind', 'Nothing was paid by debit card')}</button>`
        : pin > 0 ? `<p class="row"><span class="row-main">${L('Pin', 'Debit card')} <small>${line ? `${esc(line.name)} · ${dayShort(line.date)} · ${esc(nameOf(accountById(line.acc)))}`
          : L('Niet gevonden bij de bank', 'Not found at the bank')}</small></span>${formatEuro(pin)}</p>` : ''}
        ${line && purchase.cards ? `<button class="row tint" data-action="untie">${L('Deze pinbetaling hoort er niet bij', 'This debit card payment is not part of it')}</button>` : ''}
      </div>
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
  inzicht: insightScreen, transacties: transactionsScreen, meer: settingsScreen, categorieen: categoriesScreen, vast: fixedScreen, beleggen: investScreen,
  categorie: () => categoryScreen(routeId()),
  saldo: () => balanceScreen(accountById(routeId())),
};
// how deep the current address sits, which decides whether a change slides forward or back; the tabs are 0
const DEPTH = { meer: 1, vast: 1, categorie: 1, archief: 1, uitgaven: 1, kaart: 1, beleggen: 1, categorieen: 2, uitgave: 2, saldo: 2, betalen: 3 };
const depth = () => DEPTH[route()] ?? 0;
let shownDepth = 0;
let tapped = false; // true when a tap inside the app caused the navigation
// Insight's period bar is out once the stepper in the top card has scrolled away under it; it stays out through a redraw
let periodShown = false;
let periodWatch;

// The tab bar. Betalen starts a payment at once when there is a card to pay with.
const TABS = [
  ['overzicht', '#/', 'home', L('Overzicht', 'Overview')],
  ['potjes', '#/potjes', 'pot', L('Potjes', 'Pots')],
  ['betalen', '#/kaarten', 'scan', L('Betalen', 'Pay')],
  ['inzicht', '#/inzicht', 'chart', L('Inzicht', 'Insight')],
  ['transacties', '#/transacties', 'list', L('Transacties', 'Transactions')],
];
const TAB_OF = {
  '': 'overzicht', meer: 'overzicht', categorieen: 'overzicht', beleggen: 'overzicht', potjes: 'potjes',
  kaarten: 'betalen', kaart: 'betalen', betalen: 'betalen', archief: 'betalen', uitgaven: 'betalen', // a purchase (uitgave) keeps the tab it was opened from
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
  const next = TAB_OF[route()] ?? tab;
  if (next !== tab) view.unit = 'month'; // a year chosen on Insight stays with Insight and what is opened from it
  tab = next;
  const screen = install ? installScreen()
    : sharing && !onServer ? waitScreen()
    : card ? cardScreen(card)
    : atTill ? payScreen()
    : purchase ? purchaseScreen(purchase)
    : (SCREENS[route()] ?? overviewScreen)();
  document.body.classList.toggle('pay', atTill);
  app.innerHTML = screen.html;
  // where the goal panel's point sits: set here, as the page allows no style attributes
  app.querySelector('.goal-pop')?.style.setProperty('--at', app.querySelector('.goal-pop').dataset.at);
  periodWatch?.disconnect();
  const bar = app.querySelector('.period-bar');
  if (bar) {
    bar.classList.toggle('shown', periodShown);
    periodWatch = new IntersectionObserver(([entry]) => {
      periodShown = !entry.isIntersecting && entry.boundingClientRect.top < entry.rootBounds.top;
      bar.classList.toggle('shown', periodShown);
    }, { rootMargin: '-44px 0px 0px 0px' }); // the bar's height: it takes over as the stepper slides under it
    periodWatch.observe(app.querySelector('.period .stepper'));
  }
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
  periodShown = false;
  render();
  scrollTo(0, 0);
  if (route() === 'inzicht' && routeId()) $(routeId())?.scrollIntoView(); // Overview's net worth opens Insight at its net worth
  app.focus({ preventScroll: true });
}

// Redraws the same screen after a control on it was used, and hands the focus back to that control. The control
// stays where it was on the screen, even when what is above it grows or shrinks (another month shows other parts).
function redraw(control) {
  const top = document.querySelector(control)?.getBoundingClientRect().top;
  render();
  const again = document.querySelector(control);
  if (top !== undefined && again) scrollBy(0, again.getBoundingClientRect().top - top);
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

// Scrolls a sheet until `element` is in sight inside it, below the sheet's bar.
function reveal(element) {
  const sheet = element.closest('dialog');
  const [box, frame] = [element, sheet].map((each) => each.getBoundingClientRect());
  const top = frame.top + (sheet.querySelector('.sheet-bar')?.offsetHeight ?? 0);
  if (box.bottom > frame.bottom - 12) sheet.scrollTop += box.bottom - frame.bottom + 12;
  else if (box.top < top) sheet.scrollTop -= top - box.top;
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
      if (!message) closeDialog(dialog, 'ok');
      else {
        error.textContent = message;
        reveal(error);
      }
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

// The sheet that asks to confirm, or with `altLabel` to choose between two answers. Resolves with 'ok', 'alt' (the
// second answer) or '' when cancelled. The first button is red, as most of these delete something; `safe` makes it blue.
function confirmWith(text, okLabel, safe, altLabel = '') {
  $('confirmText').textContent = text;
  $('confirmOk').textContent = okLabel;
  $('confirmOk').className = safe ? 'row tint' : 'row danger';
  $('confirmAlt').textContent = altLabel;
  $('confirmAlt').hidden = !altLabel;
  return openDialog($('confirmDialog'));
}

async function ask(text, okLabel, safe = false) {
  return await confirmWith(text, okLabel, safe) === 'ok';
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
// `more` is how many payments wait after this one. Resolves with { shop, value }, null when cancelled, or false
// when a payment that said what it bought turns out to have bought no card.
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
  $('giftNoneGroup').hidden = !current;
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
  return answer === 'ok' ? gift : answer === 'delete' ? false : null;
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
    ${tx.text ? `<p class="row"><small class="row-main selectable">${esc(tx.text)}</small></p>` : ''}
    ${tx.early ? `<p class="row"><small class="row-main">${L('Voorlopig: geboekt, maar de bank kan dit nog aanpassen. Kassa kijkt er bij het volgende ophalen opnieuw naar.',
    'Provisional: booked, but the bank can still change it. Kassa looks at it again at the next fetch.')}</small></p>` : ''}`;
  const choice = (id, name) => `
    <label class="row choice"><input type="radio" name="cat" value="${id}"${id === before ? ' checked' : ''}>
      <span class="row-main">${name}</span>${icon('check')}</label>`;
  $('txCats').innerHTML = sortedCats().map((cat) => choice(cat.id, esc(shown(cat.name)))).join('') + choice('', L('Nog niet indelen', 'Leave unsorted'));
  const { all, fixed } = form.elements;
  $('txAllRow').hidden = !key;
  $('txAllLabel').textContent = L(`Ook al het andere van ${tx.name}`, `Everything else from ${tx.name} too`);
  // not for the shop that sells the cards: its cards are for many shops, and each payment says where its own card counts
  all.checked = Boolean(key) && tx.cat === undefined && !sellsCards(tx);
  $('txFixedRow').hidden = !key || tx.cents >= 0;
  fixed.checked = bank.fixed[key] === true;
  // "Voor wie?" shows while Boodschappen is the chosen category; the answer is kept here until the sheet is saved
  let shares = tx.shares ?? [{ who: US, cents: -tx.cents }];
  const showWho = () => {
    // not for the pin part of a till payment: who that was for is said on the purchase
    $('txWhoGroup').hidden = tx.cents >= 0 || form.elements.cat.value !== 'boodschappen' || state.purchases.some((purchase) => purchase.tx === tx.id);
    $('txWhoNow').textContent = shares.map((share) => shown(share.who)).join(', ');
  };
  // "Cadeaukaart" shows on a payment that bought cards: in the gift card category, to the shop that sells them, or
  // filled in before. What it bought stays whatever the category becomes: the category only says where it counts.
  let { gift } = tx;
  const boughtCards = () => tx.cents < 0 && (form.elements.cat.value === 'cadeaukaarten' || Boolean(gift) || sellsCards(tx));
  const showGift = () => {
    $('txGiftGroup').hidden = !boughtCards();
    $('txGiftNow').textContent = gift ? `${gift.shop} · ${formatEuro(gift.value)}` : L('Invullen', 'Fill in');
    // a card that is balance (AH, a shop whose balance is kept) stops being that outside the gift card category
    $('txGiftNote').hidden = !gift || !heldShops(bank).has(gift.shop) || ['cadeaukaarten', ''].includes(form.elements.cat.value);
  };
  $('txCats').onchange = () => { showWho(); showGift(); };
  $('txWho').onclick = async () => {
    shares = await pickShares(-tx.cents, `${formatEuro(-tx.cents)} ${L('bij', 'at')} ${tx.name}`, shares) ?? shares;
    showWho();
  };
  $('txGift').onclick = async () => {
    const picked = await pickGift(tx, gift);
    if (picked !== null) gift = picked || undefined;
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
  const filled = gift !== tx.gift; // what it bought was filled in or changed in this sheet
  if (tx.cents < 0 && gift) tx.gift = gift;
  else delete tx.gift;
  if (cat === 'boodschappen' && tx.cents < 0 && shares.some((share) => share.who !== US)) tx.shares = shares;
  else delete tx.shares;
  if (all.checked) {
    const same = sortAll(bank, tx, cat);
    if (same > 1) toast(L(`${same} transacties van ${tx.name} ingedeeld.`, `${same} transactions from ${tx.name} sorted.`));
  } else if (cat) tx.cat = cat;
  else delete tx.cat;
  if (!$('txFixedRow').hidden && fixed.checked !== (bank.fixed[key] === true)) bank.fixed[key] = fixed.checked;
  saveBank();
  if (filled && needsCard(tx)) await addBought(tx);
}

// Asks for a payment from a shop's balance: once, or every month from its date on. A name the app has not
// seen is sorted at once, so every later payment of that name follows.
async function askPayment(account) {
  const form = $('payDialog').querySelector('form');
  form.reset();
  form.elements.date.value = isoDate();
  $('payTitle').textContent = L('Betaling', 'Payment');
  $('payMonthly').hidden = false;
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

// Asks for a payment that is still to come. It counts in its month until the bank shows it.
async function askPlan() {
  const form = $('payDialog').querySelector('form');
  form.reset();
  form.elements.date.value = isoDate();
  $('payTitle').textContent = L('Betaling plannen', 'Plan a payment');
  $('payMonthly').hidden = true;
  $('payNote').textContent = L('Telt mee in de maand van de datum, tot de bank een betaling van ongeveer dit bedrag laat zien.',
    'Counts in the month of its date, until the bank shows a payment of about this amount.');
  let plan;
  const answer = await openDialog($('payDialog'), () => {
    const { name, amount, date } = form.elements;
    plan = { name: name.value.trim(), cents: parseEuro(amount.value), date: date.value };
    if (!isName(plan.name)) return L('Vul in waarvoor het is.', 'Enter what it is for.');
    if (!plan.cents) return ENTER_AMOUNT;
    if (!isDate(plan.date)) return ENTER_DATE;
    return plan.date < isoDate() ? L('Kies vandaag of een latere dag.', 'Choose today or a later day.') : '';
  });
  if (answer !== 'ok' || !plan) return; // never save a plan that was not filled in: saved data must stay readable
  bank.planned.push({ id: crypto.randomUUID().slice(0, 8), ...plan, since: isoDate() });
  saveBank();
}

// Asks for a purchase or a sale: of `fund` ({ stock, name }), or of the fund picked from `found` (what a search gave,
// at least one). `trade` is the one to change. Resolves with the trade, 'delete' to remove `trade`, or null when cancelled.
async function askTrade({ trade, fund, found = [] }) {
  const form = $('tradeDialog').querySelector('form');
  const field = form.elements;
  form.reset();
  field.qty.value = trade ? String(Math.abs(trade.qty)).replace('.', L(',', '.')) : '';
  field.amount.value = trade ? euroInput(Math.abs(trade.cents)) : '';
  field.date.value = trade?.date ?? isoDate();
  field.sold.checked = trade?.qty < 0;
  field.sold.onchange = () => {
    $('tradeTitle').textContent = field.sold.checked ? L('Verkoop', 'Sale') : L('Aankoop', 'Purchase');
    $('tradeDelete').textContent = field.sold.checked ? L('Deze verkoop verwijderen', 'Delete this sale') : L('Deze aankoop verwijderen', 'Delete this purchase');
  };
  field.sold.onchange();
  $('tradeDeleteGroup').hidden = !trade;
  $('tradeFoundTitle').hidden = $('tradeFound').hidden = $('tradeFoundNote').hidden = Boolean(fund);
  $('tradeFound').innerHTML = found.map((each, index) => `
    <label class="row choice"><input type="radio" name="pick" value="${index}"${index ? '' : ' checked'}>
      <span class="row-main">${esc(each.name)} <small>${esc(each.where)} · ${esc(each.stock)}</small></span>${icon('check')}</label>`).join('');
  // the fields are at the top, in reach above the keyboard; the note over them names the fund chosen in the list under them
  $('tradeFound').onchange = () => {
    const { name, stock } = fund ?? found[Number(field.pick.value)];
    $('tradeNote').textContent = `${name} · ${stock}`;
  };
  $('tradeFound').onchange();
  let next;
  const answer = await openDialog($('tradeDialog'), () => {
    const { stock, name } = fund ?? found[Number(field.pick.value)];
    const qty = Number(field.qty.value.trim().replace(',', '.'));
    const cents = parseEuro(field.amount.value, 7);
    const sign = field.sold.checked ? -1 : 1;
    if (!(qty > 0)) return L('Vul in hoeveel het er waren, bijvoorbeeld 3.', 'Enter how many there were, for example 3.');
    if (cents === null) return ENTER_AMOUNT;
    if (!isDate(field.date.value) || field.date.value > isoDate()) return L('Kies vandaag of een eerdere dag.', 'Choose today or an earlier day.');
    next = { id: trade?.id ?? crypto.randomUUID().slice(0, 8), stock, name, date: field.date.value, qty: sign * qty, cents: sign * cents };
    return isTrade(next) ? '' : L('Dit kan zo niet worden opgeslagen.', 'This cannot be saved like this.');
  });
  return answer === 'ok' ? next : answer === 'delete' ? 'delete' : null;
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

// The sheet of the savings goal: its name, what to save every month and up to three amounts to reach, each with a
// name. The amounts are put in order; the month the goal starts is the month it was made in.
async function editGoal() {
  const goal = bank.goal;
  const form = $('goalDialog').querySelector('form');
  const field = form.elements;
  const big = (cents) => (cents / 100).toLocaleString(LOCALE, { maximumFractionDigits: 2 });
  form.reset();
  field.name.value = goal?.name ?? '';
  field.monthly.value = goal ? big(goal.monthly) : '';
  for (const [index, step] of (goal?.steps ?? []).entries()) {
    field[`stepCents${index}`].value = big(step.cents);
    field[`stepName${index}`].value = step.name;
  }
  const { usual } = salaryBase(bank, state.purchases, thisMonth());
  field.monthly.oninput = () => {
    const cents = parseBig(field.monthly.value);
    $('goalHint').textContent = !usual || !cents ? ''
      : cents > usual ? L(`Meer dan je gemiddelde salaris van ${wholeEuro(usual)}.`, `More than your average salary of ${wholeEuro(usual)}.`)
      : L(`${Math.round(cents / usual * 100)}% van je gemiddelde salaris van ${wholeEuro(usual)}. Dan blijft er ${wholeEuro(usual - cents)} per maand om uit te geven.`,
        `${Math.round(cents / usual * 100)}% of your average salary of ${wholeEuro(usual)}. That leaves ${wholeEuro(usual - cents)} a month to spend.`);
  };
  field.monthly.oninput();
  $('goalDeleteGroup').hidden = !goal;
  let next;
  const answer = await openDialog($('goalDialog'), () => {
    const steps = [];
    for (const index of [0, 1, 2]) {
      const [amount, name] = [field[`stepCents${index}`].value.trim(), field[`stepName${index}`].value.trim()];
      if (!amount && !name) continue;
      if (!parseBig(amount) || !isName(name)) return L('Vul bij elke mijlpaal een bedrag en een naam in.', 'Enter an amount and a name for each milestone.');
      steps.push({ cents: parseBig(amount), name });
    }
    steps.sort((a, b) => a.cents - b.cents);
    next = { name: field.name.value.trim(), monthly: parseBig(field.monthly.value), start: goal?.start ?? thisMonth(), steps };
    if (!isName(next.name)) return L('Vul een naam in.', 'Enter a name.');
    if (!next.monthly) return ENTER_AMOUNT;
    if (!steps.length) return L('Vul minstens één mijlpaal in.', 'Enter at least one milestone.');
    return isGoal(next) ? '' : L('Twee mijlpalen hebben hetzelfde bedrag.', 'Two milestones have the same amount.'); // the one way left to fail
  });
  if (answer === 'delete') {
    if (!await ask(L(`Doel ${goal.name} verwijderen?`, `Delete the goal ${goal.name}?`), L('Verwijderen', 'Delete'))) return;
    delete bank.goal;
    view.goal = '';
    saveBank();
    return;
  }
  if (answer !== 'ok' || !next) return; // never save a goal that was not checked: saved data must stay readable
  bank.goal = next;
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
      if (isPdf) added += addFile(bank, readPdf(await pdfItems(bytes)), now);
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
    store(KEY, state);
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

// what an AH gift card payment bought that is not on a card in the app yet
const worthLeft = (tx) => tx.gift.value - state.cards.reduce((sum, card) => sum + (card.tx === tx.id ? card.entries[0]?.delta ?? 0 : 0), 0);

// Adds a card, or edits `card` when given. `bought` is the bank payment that bought the new card: what it is worth
// is filled in, and a card that is in the app already is tied to the payment instead of refused.
// Resolves with true when something was saved.
async function editCard(card, bought) {
  const form = $('cardDialog').querySelector('form');
  const field = form.elements;
  form.reset();
  $('cardTitle').textContent = card ? L('Kaart bewerken', 'Edit card') : L('Kaart toevoegen', 'Add card');
  $('cardNote').hidden = !bought;
  $('cardNote').textContent = bought ? L(`${AH}, ${formatEuro(-bought.cents)} betaald op ${dayShort(bought.date)}. Het nummer en de code staan in de mail van de kaart. Was de kaart niet voor jezelf, deel de betaling dan anders in.`,
    `${AH}, ${formatEuro(-bought.cents)} paid on ${dayShort(bought.date)}. The number and the code are in the email with the card. Was the card not for yourself, then sort the payment differently.`) : '';
  field.start.closest('label').hidden = Boolean(card); // the balance of an existing card changes through its history
  if (card) {
    field.number.value = groupNumber(card.number);
    field.code.value = card.code;
    field.expiry.value = card.expiry;
  }
  if (bought) field.start.value = euroInput(worthLeft(bought));
  let next;
  let known; // the card with that number, when it is in the app already
  const answer = await openDialog($('cardDialog'), () => {
    next = {
      number: cleanDigits(field.number.value),
      code: cleanDigits(field.code.value),
      expiry: field.expiry.value,
      start: parseEuro(field.start.value),
    };
    known = state.cards.find((other) => other !== card && other.number === next.number);
    if (!validNumber(next.number)) return L('Het kaartnummer moet 19 cijfers hebben.', 'The card number must have 19 digits.');
    if (!validCode(next.code)) return L('De beveiligingscode moet 6 cijfers hebben.', 'The security code must have 6 digits.');
    if (known && (!bought || known.tx === bought.id)) return L('Deze kaart staat er al in.', 'This card is already in the app.');
    if (!card && !known && !next.start) return L('Vul het saldo in, bijvoorbeeld 25,00.', 'Enter the balance, for example 25.00.');
    if (next.expiry && !isDate(next.expiry)) return ENTER_DATE;
    return '';
  });
  if (answer !== 'ok') return false;
  const { number, code, expiry, start } = next;
  // Another number on a card that is in the app is nearly always another card, and typing it over this one loses
  // this card's number and code while its balance stays: so that is asked first.
  if (card && card.number !== number && !await ask(L(`Het kaartnummer verandert. Kaart ${last4(card)} houdt zijn saldo van ${formatEuro(balance(card))} en zijn geschiedenis. Is het een andere kaart, annuleer dan en voeg hem toe met de plus.`,
    `The card number changes. Card ${last4(card)} keeps its balance of ${formatEuro(balance(card))} and its history. If it is another card, cancel and add it with the plus.`),
  L('Het is dezelfde kaart', 'It is the same card'), true)) return false;
  if (known) {
    known.tx = bought.id; // its balance and history stay as they are
    toast(L(`Kaart ${last4(known)} stond er al in en hoort nu bij deze aankoop.`, `Card ${last4(known)} was in the app already and now belongs to this purchase.`));
  } else if (!card) {
    state.cards.push({ id: crypto.randomUUID(), number, code, expiry, ...(bought && { tx: bought.id }), entries: [newEntry('start', start)] });
    state.needsBackup = true;
  } else {
    if (card.number !== number || card.code !== code) state.needsBackup = true;
    Object.assign(card, { number, code, expiry });
  }
  save();
  return true;
}

// Asks for the cards an AH gift card payment bought, one after the other until they hold what was bought: one
// payment can buy several cards. Stopping halfway is fine: Kaarten keeps asking for a payment without any card.
async function addBought(tx) {
  while (worthLeft(tx) > 0 && await editCard(undefined, tx));
}
// the AH gift card payment that has no card in the app yet, when `tx` is one
const needsCard = (tx) => cardsToAdd(bank, state.cards, isoDate()).includes(tx);

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
  if (resized) {
    delete purchase.wait; // a total that was typed is the total: nothing is waited for
    delete purchase.tx; // and it has another pin part; the bank line of that amount is found on saving (tie)
  }
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
  store(KEY, state);
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
  linkBank: (card, button) => linkBank(button.dataset.id),
  fetchBank: () => fetchBank(true),
  pushOn,
  pushOff,
  pushLater() {
    localStorage.setItem(PUSH_LATER, '1');
    render();
  },
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
  // the pin part of a till payment opens that purchase: it is sorted and split there, as one
  tx(card, button) {
    const tx = bank.txs.find((each) => each.id === button.dataset.id);
    const till = tillOf(tx, sorter(bank)(tx));
    if (till) go(`#/uitgave/${till.id}`);
    else askTx(tx);
  },
  sortParty: (card, button) => askTx(bank.txs.find((tx) => tx.id === button.dataset.id)),
  addCat: () => editCat(),
  editCat: (card, button) => editCat(catById(button.dataset.id)),
  deleteCat: (card, button) => closeDialog(button.closest('dialog'), 'delete'),
  editGoal: () => editGoal(),
  deleteGoal: (card, button) => closeDialog(button.closest('dialog'), 'delete'),
  // a month on the goal's bars opens its panel; the same month again closes it
  pickGoal(card, button) {
    view.goal = view.goal === button.dataset.id ? '' : button.dataset.id;
    redraw(`[data-action="pickGoal"][data-id="${button.dataset.id}"]`);
  },
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
      if (needsCard(tx)) await addBought(tx); // an AH card: its number and code right away, so it is in Kaarten
    }
  },
  addBought: (card, button) => addBought(bank.txs.find((tx) => tx.id === button.dataset.id)),
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
  noGift: (card, button) => closeDialog(button.closest('dialog'), 'delete'),
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
  plan() { askPlan(); },
  async unplan(card, button) {
    const plan = bank.planned.find((each) => each.id === button.dataset.id);
    if (!plan || !await ask(L(`${plan.name} van ${formatEuro(plan.cents)} niet meer plannen?`, `Stop planning ${plan.name} of ${formatEuro(plan.cents)}?`), L('Verwijderen', 'Remove'))) return;
    bank.planned = bank.planned.filter((each) => each !== plan);
    saveBank();
  },
  // investing: a purchase of a fund that is not held yet starts with a search for it
  async addTrade() {
    if (!sharing) {
      toast(L('Zet eerst delen aan bij Instellingen: de koersen komen via de Kassa-server.', 'Switch on sharing in Settings first: the prices come through the Kassa server.'));
      return;
    }
    const text = await askText(L('Fonds zoeken', 'Find a fund'), L('Naam, ticker of ISIN', 'Name, ticker or ISIN'), '',
      { check: (value) => (value ? '' : L('Vul een naam in.', 'Enter a name.')), max: 60, ok: L('Zoek', 'Search') });
    if (text === null) return;
    toast(L('Zoeken…', 'Searching…'));
    let found;
    try {
      found = (await api('GET', `/find?q=${encodeURIComponent(text)}`, { token: await tokenOf(household) })).map(({ id, name, where }) => ({ stock: id, name, where }));
    } catch (error) {
      if (error.status === 502) toast(L('De koersen zijn nu niet bereikbaar. Probeer het later opnieuw.', 'The prices cannot be reached now. Try again later.'));
      else shareError(error);
      return;
    }
    if (!found.length) {
      toast(L(`Niets gevonden voor ${text}. Probeer de ticker, zoals VWCE.`, `Nothing found for ${text}. Try the ticker, such as VWCE.`));
      return;
    }
    toast('');
    const trade = await askTrade({ found });
    if (!trade) return;
    bank.trades.push(trade);
    saveBank();
    fetchQuotes();
  },
  // a tap on a fund that is held: more of it was bought, or some of it sold
  async trade(card, button) {
    const trade = await askTrade({ fund: holdings(bank).find((fund) => fund.stock === button.dataset.id) });
    if (!trade) return;
    bank.trades.push(trade);
    saveBank();
  },
  async editTrade(card, button) {
    const trade = bank.trades.find((each) => each.id === button.dataset.id);
    const next = await askTrade({ trade, fund: trade });
    if (!next) return;
    bank.trades = bank.trades.filter((each) => each !== trade);
    if (next !== 'delete') bank.trades.push(next);
    saveBank();
    fetchQuotes();
  },
  deleteTrade: (card, button) => closeDialog(button.closest('dialog'), 'delete'),
  fixedYes(card, button) { bank.fixed[button.dataset.id] = true; saveBank(); },
  fixedNo(card, button) { bank.fixed[button.dataset.id] = false; saveBank(); },
  // which month (or year) the pots, a category, the fixed costs and the insight screen show
  monthStep(card, button) {
    const by = Number(button.dataset.by) * (['inzicht', 'categorie'].includes(route()) && view.unit === 'year' ? 12 : 1);
    const month = shiftMonth(view.month, by);
    Object.assign(view, { month: month > thisMonth() ? thisMonth() : month, worth: '' });
    redraw(`[data-by="${button.dataset.by}"]`);
  },
  pickMonth(card, button) {
    Object.assign(view, { month: button.dataset.id, unit: 'month', worth: '' });
    redraw('.column[aria-pressed="true"]');
  },
  unit(card, button) {
    Object.assign(view, { unit: button.dataset.id, worth: '' });
    redraw(`[data-action="unit"][data-id="${view.unit}"]`);
  },
  // a month on the net worth line: only the net worth shows that month, the rest of the screen stays
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
    actions.back();
  },
  // "Nee, ook gepind" was a slip, or the rest was paid some other way: the purchase is what the cards paid
  noPin() {
    delete currentPurchase().wait;
    save();
  },
  // The bank line is not this purchase's pin part: the purchase goes back to what the cards paid, and the line is
  // a transaction of its own again. Typing the real total (Bewerken) finds the right line.
  async untie() {
    const purchase = currentPurchase();
    const pin = purchase.total - purchase.cards;
    if (!await ask(L(`Hoort de pinbetaling van ${formatEuro(pin)} niet bij deze aankoop? De aankoop wordt dan ${formatEuro(purchase.cards)}.`,
      `Is the debit card payment of ${formatEuro(pin)} not part of this purchase? The purchase then becomes ${formatEuro(purchase.cards)}.`), L('Loskoppelen', 'Take it off'))) return;
    const main = purchase.shares[0].who;
    const kept = shareOut(purchase.cards, main, purchase.shares.slice(1).map((share) => [share.who, share.cents]));
    Object.assign(purchase, { total: purchase.cards, shares: kept === 'over' ? [{ who: main, cents: purchase.cards }] : kept });
    delete purchase.tx;
    save();
  },
  alt: (card, button) => closeDialog(button.closest('dialog'), 'alt'),

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
  // a tap anywhere but on the goal's month panel or its months closes the panel
  if (view.goal && !event.target.closest('.goal-pop, [data-action="pickGoal"]')) {
    view.goal = '';
    render();
  }
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
  if (event.key === 'Escape' && view.goal && !busy()) {
    const id = view.goal;
    view.goal = '';
    redraw(`[data-action="pickGoal"][data-id="${id}"]`);
    return;
  }
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
// The iPhone does not make the page smaller for its keyboard: it lays the keyboard over the page and slides the
// visible part down to the field being typed in. A sheet that stayed as tall as the page, and followed that slide to
// keep its bar on screen, held a field in its lower half behind the keyboard. So a sheet is as high as the visible
// part (--view) and follows it (--pan; style.css uses both), and the field in use is scrolled into sight inside the
// sheet. Zoomed in, the height of the visible part says nothing about a keyboard.
function fit() {
  const root = document.documentElement.style;
  root.setProperty('--pan', `${visualViewport.offsetTop}px`);
  if (visualViewport.scale === 1) root.setProperty('--view', `${visualViewport.height}px`);
  else root.removeProperty('--view');
  const field = document.activeElement;
  if (field?.matches('dialog[open] :is(input, select)')) reveal(field.closest('label') ?? field);
}
if (window.visualViewport) {
  visualViewport.addEventListener('scroll', fit);
  visualViewport.addEventListener('resize', fit);
  document.addEventListener('focusin', fit); // the next field, with the keyboard up already
  fit();
}

// index.html is written in Dutch; data-en holds an element's English text, or an input's English placeholder
document.documentElement.lang = lang;
if (lang === 'en') {
  for (const element of document.querySelectorAll('[data-en]')) element[element.matches('input') ? 'placeholder' : 'textContent'] = element.dataset.en;
}

navigator.storage?.persist?.(); // ask the browser not to evict the cards
navigator.serviceWorker?.register('sw.js');
// A newer Kassa was saved on the phone while this one was open: start it, unless that would break off a payment or a sheet.
if (navigator.serviceWorker?.controller) {
  navigator.serviceWorker.addEventListener('controllerchange', () => busy() || ['betalen', 'kaart'].includes(route()) || location.reload());
}
if (sharing) forgetLocal();
state = load();
bank = loadBank();
if (tie(bank, state)) save(); // what an earlier Kassa left untied
if (catchUp(bank, isoDate()).length) saveBank();
else render();
sync();
const back = new URLSearchParams(location.search);
if (back.has('state')) backFromBank(back);
else fetchBank();
fetchQuotes();
startPush();
reportMonth();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (catchUp(bank, isoDate()).length) saveBank();
  sync(); // what the other phone changed meanwhile
  fetchBank();
  fetchQuotes();
});
addEventListener('online', () => sync());
document.addEventListener('close', () => sync(), true); // a change that waited for a sheet to close goes up now
setInterval(() => document.hidden || (sync(), fetchBank(), fetchQuotes()), 10_000); // while Kassa is on screen: the other phone's changes show up within seconds
