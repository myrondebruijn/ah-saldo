import {
  balance, cleanDigits, code128, daysLeft, expiryState, formatEuro, groupNumber, isDate, isName, isoDate, isoWeek,
  needsInstall, parseEuro, parseState, periodStart, settle, shareOut, shiftPeriod, sortCards, summarize,
  validCode, validNumber,
} from './logic.js';

const KEY = 'ah-saldo';
// AH's official "Saldochecker AH cadeaukaart" link, as published on ah.nl
const CHECKER = 'https://service2.loyaltyinabox.com/CardBalanceChecker/2/paymentapi.aspx?cmd=showbalance&username=1379001&lang=nl-NL';
const KIND = { start: 'Beginsaldo', pay: 'Betaling', correct: 'Correctie' };
const US = 'Wij'; // who a purchase is for until someone else is chosen
const SHOPS = ['AH', 'Jumbo', 'Plus', 'Lidl', 'Aldi'];
const UNITS = { week: 'Week', month: 'Maand', year: 'Jaar' };
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
    toast('De opgeslagen kaarten zijn onleesbaar. Zet een back-up terug.');
    return empty;
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    toast('Opslaan is mislukt. Maak nu een back-up.');
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
  new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', timeZone });
const signed = (delta) => `${delta < 0 ? '−' : '+'} ${formatEuro(Math.abs(delta))}`;
const euroInput = (cents) => (cents / 100).toFixed(2).replace('.', ','); // an amount as it is typed: 12,50
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const cardById = (id) => state.cards.find((card) => card.id === id);
const purchaseById = (id) => state.purchases.find((purchase) => purchase.id === id);
// the defaults first, then what has been used so far, most recent first
const listed = (defaults, used) => [...new Set([...defaults, ...used.reverse()])];
const people = () => listed([US], state.purchases.flatMap((purchase) => purchase.shares.map((share) => share.who)));
const shops = () => listed(SHOPS, state.purchases.map((purchase) => purchase.store));
const whoText = (purchase) => purchase.shares.map((share) => share.who).join(', ');

function expiryLabel(card) {
  if (!card.expiry) return '';
  const days = daysLeft(card.expiry, isoDate());
  if (days < 0) return `Verlopen op ${formatDate(card.expiry, 'UTC')}`;
  if (days === 0) return 'Verloopt vandaag';
  if (days <= 30) return `Verloopt over ${plural(days, 'dag', 'dagen')}`;
  return `Geldig tot ${formatDate(card.expiry, 'UTC')}`;
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
    aria-label="Barcode van kaart ${last4(card)}">${bars}</svg>`;
}

// What the till needs from one card: barcode, number and code, on white.
const ticket = (card) => `
  <section class="ticket">
    ${barcode(card)}
    <dl>
      <dt>Kaartnummer</dt>
      <dd class="number">${groupNumber(card.number)}</dd>
      <dt>Beveiligingscode</dt>
      <dd class="code">${card.code}</dd>
    </dl>
  </section>`;

const blank = (title, text = '') => `
  <div class="blank">${icon('card')}<strong>${title}</strong>${text}</div>`;

// how a purchase was paid: the gift card part and the rest
const paidWith = (cards, total) => `
  <ul class="group">
    <li class="row"><span class="row-main">Cadeaukaarten</span>${formatEuro(cards)}</li>
    <li class="row"><span class="row-main">Pin</span>${formatEuro(total - cards)}</li>
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
        <h1>AH Saldo</h1>
        <button class="round" data-action="add" aria-label="Kaart toevoegen">${icon('plus')}</button>
      </header>
      <section class="summary">
        <p class="footnote">Totaal saldo</p>
        <p class="total">${formatEuro(total)}</p>
        <p class="footnote">${plural(active.length, 'kaart', 'kaarten')}</p>
      </section>
      ${state.needsBackup ? `
        <div class="group">
          <p class="row notice">${icon('warn')}<span class="row-main">Je hebt nieuwe kaarten zonder back&#8209;up.</span></p>
          <button class="row tint" data-action="export">Back-up maken</button>
        </div>` : ''}
      <h2 class="section">Kaarten</h2>
      ${active.length
        ? `<ul class="passes">${passes}</ul>`
        : blank('Nog geen kaarten', 'Voeg je eerste AH cadeaukaart toe.')}
      <div class="group">
        <a class="row" href="#/uitgaven">
          <span class="row-main">Uitgaven <small>Deze maand</small></span> ${formatEuro(thisMonth)}${icon('next')}</a>
        ${spent ? `<a class="row" href="#/archief"><span class="row-main">Lege kaarten</span> ${spent}${icon('next')}</a>` : ''}
      </div>
      <h2 class="section">Back-up</h2>
      <div class="group">
        <button class="row tint" data-action="export">Back-up maken</button>
        <button class="row tint" data-action="import">Terugzetten</button>
      </div>
      <p class="group-note">Je kaarten staan alleen op deze telefoon. Het back&#8209;upbestand bevat alle nummers
        en codes: bewaar het als contant geld.</p>`,
    // paying with gift cards is the thumb button; a purchase paid another way sits beside it
    dock: `
      <button class="button" data-action="addPurchase">${icon('plus')}Uitgave</button>
      ${active.length
        ? '<a class="button primary" href="#/betalen">Betalen</a>'
        : '<button class="button primary" data-action="add">Kaart toevoegen</button>'}`,
  };
}

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
        aria-label="${KIND[entry.kind]} van ${formatEuro(Math.abs(entry.delta))} verwijderen">${icon('trash')}</button>`}</li>`;
  }).join('');
  return {
    html: `
      <header class="navbar">
        <a class="back" href="${left > 0 ? '#/' : '#/archief'}">${icon('back')}${left > 0 ? 'Kaarten' : 'Lege kaarten'}</a>
        <h1><span>Kaart </span>${last4(card)}</h1>
        <button class="text-button" data-action="edit">Bewerken</button>
      </header>
      ${ticket(card)}
      <div class="saldo">
        <p class="total">${formatEuro(left)}</p>
        ${expiryHtml(card)}
      </div>
      ${left > 0 ? '' : '<p class="group-note">Deze kaart is leeg en staat bij Lege kaarten.</p>'}
      <div class="group">
        <button class="row tint" data-action="check"><span class="row-main">Saldo checken</span>${icon('out')}</button>
        <button class="row tint" data-action="correct">Saldo corrigeren</button>
      </div>
      <h2 class="section">Geschiedenis</h2>
      <ul class="group">${history}</ul>
      <div class="group">
        <button class="row danger" data-action="delete">Verwijderen</button>
      </div>`,
    dock: left > 0 ? '<button class="button primary" data-action="payFrom">Betalen met deze kaart</button>' : '',
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
        <a class="back" href="#/">${icon('back')}Kaarten</a>
        <h1>Lege kaarten</h1>
        <span></span>
      </header>
      ${spent.length ? `<ul class="group">${rows}</ul>` : blank('Geen lege kaarten')}`,
  };
}

const installScreen = () => ({
  html: `
    <section class="install">
      <img src="icon-180.png" alt="" width="88" height="88">
      <h1>Zet de app eerst op je beginscherm</h1>
      <p>Safari kan de gegevens van een website na een week zonder gebruik wissen. Op je beginscherm
        blijven je kaarten bewaard.</p>
      <ol class="group steps">
        <li class="row"><b aria-hidden="true">1</b><span>Tik in Safari op <strong>Deel</strong> (het vierkant met de pijl omhoog).</span></li>
        <li class="row"><b aria-hidden="true">2</b><span>Kies <strong>Zet op beginscherm</strong>.</span></li>
        <li class="row"><b aria-hidden="true">3</b><span>Open AH Saldo vanaf je beginscherm.</span></li>
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
    ? `<button class="back" data-action="payBack">${icon('back')}Vorige</button>`
    : `<a class="back" href="#/">${icon('back')}Kaarten</a>`;
  if (!card) {
    return {
      html: `
        <header class="navbar">${back}<h1>Betalen</h1><span></span></header>
        ${blank('Geen kaarten meer', 'Betaal de rest met pin.')}`,
      dock: '<button class="button primary" data-action="payDone">Klaar</button>',
    };
  }
  return {
    html: `
      <header class="navbar">
        ${back}
        <h1><span>Kaart </span>${paying.steps.length + 1} van ${paying.queue.length}</h1>
        <button class="text-button" data-action="paySkip">Overslaan</button>
      </header>
      ${ticket(card)}
      <div class="saldo">
        <p class="total">${formatEuro(balance(card))}</p>
        ${expiryHtml(card)}
      </div>`,
    dock: `
      <button class="button" data-action="payNext">Volgende kaart</button>
      <button class="button primary" data-action="payDone">Klaar</button>`,
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
  const total = await askAmount('Afronden', 'Totaalbedrag', (cents) => {
    if (settle(balances, cents) !== 'low') return '';
    return earlier ? `Dat dekten de vorige kaarten al (${formatEuro(earlier)}). Ga terug met Vorige.` : 'Vul een bedrag in, bijvoorbeeld 12,50.';
  });
  if (total === null) return;
  const taken = settle(balances, total);
  const fromCards = taken.reduce((sum, cents) => sum + cents, 0);
  const purchase = newPurchase('AH', total, fromCards);
  cards.forEach((card, index) => card.entries.push({ ...newEntry('pay', -taken[index]), purchase: purchase.id }));
  state.purchases.push(purchase);
  save();
  toast(!fromCards ? `${formatEuro(total)} vastgelegd.`
    : total > fromCards ? `${formatEuro(fromCards)} met kaarten, ${formatEuro(total - fromCards)} met pin.`
    : `${formatEuro(fromCards)} afgeschreven van ${plural(cards.length, 'kaart', 'kaarten')}.`);
  goHome();
  askWho(purchase);
}

// ---------- purchases and statistics ----------

let stats = { unit: 'month', start: periodStart('month', new Date()) }; // the period on the statistics screen

const periodName = (unit, start) => (unit === 'week' ? `Week ${isoWeek(start)}`
  : unit === 'month' ? start.toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' })
  : String(start.getFullYear()));
const periodShort = (unit, start) => (unit === 'week' ? String(isoWeek(start))
  : unit === 'month' ? start.toLocaleDateString('nl-NL', { month: 'short' }).replace('.', '')
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
    <span class="row-main">${esc(name)}</span>
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
      <span class="row-main">${esc(purchase.store)} <small>${formatDate(purchase.at)} · ${esc(whoText(purchase))}</small></span>
      ${formatEuro(purchase.total)}${icon('next')}
    </a></li>`).join('');
  return {
    html: `
      <header class="navbar">
        <a class="back" href="#/">${icon('back')}Kaarten</a>
        <h1>Uitgaven</h1>
        <span></span>
      </header>
      <div class="segments" role="group" aria-label="Periode">
        ${Object.entries(UNITS).map(([key, label]) => `
          <button data-action="statUnit" data-unit="${key}" aria-pressed="${key === unit}">${label}</button>`).join('')}
      </div>
      <section class="summary period">
        <div class="stepper">
          <button data-action="statStep" data-by="-1" aria-label="Vorige periode">${icon('back')}</button>
          <h2>${periodName(unit, start)}${unit === 'week' ? `
            <small>${start.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} t/m ${formatDate(lastDay)}</small>` : ''}</h2>
          <button data-action="statStep" data-by="1" aria-label="Volgende periode"${isCurrent ? ' disabled' : ''}>${icon('next')}</button>
        </div>
        <p class="total">${formatEuro(sum.total)}</p>
        <ul class="columns">${trendChart(unit, start)}</ul>
      </section>
      ${sum.purchases.length ? `
        <h2 class="section">Voor wie</h2>
        <ul class="group">${meters(sum.byWho, sum.total)}</ul>
        <h2 class="section">Winkels</h2>
        <ul class="group">${meters(sum.byStore, sum.total)}</ul>
        <h2 class="section">Betaald met</h2>
        ${paidWith(sum.cards, sum.total)}
        <h2 class="section">Betalingen</h2>
        <ul class="group">${rows}</ul>`
      : blank('Geen uitgaven', 'In deze periode is niets vastgelegd.')}`,
    dock: '<button class="button primary" data-action="addPurchase">Uitgave toevoegen</button>',
  };
}

function purchaseScreen(purchase) {
  const day = new Date(purchase.at).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return {
    html: `
      <header class="navbar">
        <a class="back" href="#/uitgaven">${icon('back')}Uitgaven</a>
        <h1>${esc(purchase.store)}</h1>
        <button class="text-button" data-action="editPurchase">Bewerken</button>
      </header>
      <section class="summary">
        <p class="footnote">${day}</p>
        <p class="total">${formatEuro(purchase.total)}</p>
      </section>
      <h2 class="section">Voor wie</h2>
      <div class="group">
        ${purchase.shares.map((share) => `
          <p class="row"><span class="row-main">${esc(share.who)}</span>${formatEuro(share.cents)}</p>`).join('')}
        <button class="row tint" data-action="who">Wijzigen</button>
      </div>
      <h2 class="section">Betaald met</h2>
      ${paidWith(purchase.cards, purchase.total)}
      <div class="group">
        <button class="row danger" data-action="deletePurchase">Verwijderen</button>
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
    return cents === null ? 'Vul een bedrag in, bijvoorbeeld 12,50.' : check(cents);
  });
  return answer === 'ok' ? cents : null;
}

// Asks who a purchase was for and saves the answer. One name takes everything; with Verdelen on, the
// other names get the amounts typed behind them and the chosen name gets what is left.
async function askWho(purchase) {
  const form = $('whoDialog').querySelector('form');
  const main = purchase.shares[0].who; // shares are kept largest first
  const part = (who) => (who === main ? '' : euroInput(purchase.shares.find((share) => share.who === who)?.cents ?? 0)).replace(/^0,00$/, '');
  const choice = (who, name) => `
    <label class="row choice">
      <input type="radio" name="who" value="${esc(who)}"${who === main ? ' checked autofocus' : ''}>
      ${name}${icon('check')}
      <input class="part" data-who="${esc(who)}" inputmode="decimal" autocomplete="off" placeholder="0,00"
        value="${part(who)}" aria-label="Bedrag voor ${esc(who) || 'de andere naam'}">
    </label>`;
  $('whoNote').textContent = `${formatEuro(purchase.total)} bij ${purchase.store}`;
  $('whoNames').innerHTML = people().map((who) => choice(who, `<span class="row-main">${esc(who)}</span>`)).join('')
    + choice('', '<input class="row-main" name="other" maxlength="30" autocomplete="off" placeholder="Andere naam" aria-label="Andere naam">');
  form.elements.split.checked = purchase.shares.length > 1;
  const other = form.elements.other;
  other.oninput = () => { other.closest('label').querySelector('[type="radio"]').checked = true; }; // typing a new name chooses it
  let shares;
  const answer = await openDialog($('whoDialog'), () => {
    const typed = other.value.trim();
    const chosen = form.elements.who.value || typed;
    if (!isName(chosen)) return 'Kies een naam of vul er een in.';
    const parts = [];
    for (const input of form.elements.split.checked ? form.querySelectorAll('.part') : []) {
      const who = input.dataset.who || typed;
      const cents = input.value.trim() ? parseEuro(input.value) : 0;
      if (cents === null) return 'Vul bedragen in zoals 12,50.';
      if (cents && !isName(who)) return 'Vul een naam in bij het bedrag.';
      if (cents && who !== chosen) parts.push([who, cents]);
    }
    shares = shareOut(purchase.total, chosen, parts);
    return shares === 'over' ? `Dat is samen meer dan ${formatEuro(purchase.total)}.` : '';
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
  $('cardTitle').textContent = card ? 'Kaart bewerken' : 'Kaart toevoegen';
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
    if (!validNumber(next.number)) return 'Het kaartnummer moet 19 cijfers hebben.';
    if (!validCode(next.code)) return 'De beveiligingscode moet 6 cijfers hebben.';
    if (state.cards.some((other) => other !== card && other.number === next.number)) return 'Deze kaart staat er al in.';
    if (!card && !next.start) return 'Vul het saldo in, bijvoorbeeld 25,00.';
    if (next.expiry && !isDate(next.expiry)) return 'Vul een geldige datum in.';
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
  $('purchaseTitle').textContent = purchase ? 'Uitgave bewerken' : 'Uitgave toevoegen';
  $('storeList').innerHTML = shops().map((shop) => `<option value="${esc(shop)}">`).join('');
  // a new purchase starts with the shop of the last one that was paid without cards
  field.store.value = purchase ? purchase.store : state.purchases.findLast((each) => !each.cards)?.store ?? '';
  field.store.autofocus = !field.store.value; // start typing where something is still missing
  field.total.autofocus = Boolean(field.store.value);
  const before = isoDate(new Date(purchase?.at ?? Date.now()));
  field.total.value = purchase ? euroInput(purchase.total) : '';
  field.date.value = before;
  let next;
  const answer = await openDialog($('purchaseDialog'), () => {
    next = { store: field.store.value.trim(), total: parseEuro(field.total.value), date: field.date.value };
    if (!isName(next.store)) return 'Vul de winkel in.';
    if (!next.total) return 'Vul het bedrag in, bijvoorbeeld 25,00.';
    if (purchase && next.total < purchase.cards) return `Minstens ${formatEuro(purchase.cards)}: zoveel is met cadeaukaarten betaald.`;
    if (!isDate(next.date)) return 'Vul een geldige datum in.';
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
  const name = `ah-saldo-backup-${isoDate()}.json`;
  const { cards, purchases } = state;
  const json = JSON.stringify({ app: 'ah-saldo', version: 1, exportedAt: new Date().toISOString(), cards, purchases }, null, 2);
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
    toast('Dit is geen geldige AH Saldo back-up.');
    return;
  }
  const sure = await ask(
    `Back-up met ${next.cards.length} kaarten terugzetten? Dit vervangt de ${state.cards.length} kaarten en alle uitgaven die nu in de app staan.`,
    'Terugzetten',
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
    const sure = await ask(
      `Uitgave van ${formatEuro(purchase.total)} bij ${purchase.store} verwijderen?${purchase.cards ? ' De gebruikte kaarten krijgen hun saldo terug.' : ''}`,
      'Verwijderen',
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
    navigator.clipboard?.writeText(card.number).then(() => toast('Kaartnummer gekopieerd.'), () => {});
    window.open(CHECKER, '_blank', 'noopener');
  },

  async correct(card) {
    const now = await askAmount('Saldo corrigeren', 'Nieuw saldo');
    if (now === null || now === balance(card)) return;
    card.entries.push(newEntry('correct', now - balance(card)));
    save();
  },

  async delete(card) {
    const sure = await ask(
      `Kaart ${last4(card)} met ${formatEuro(balance(card))} verwijderen? Dit kan niet ongedaan worden gemaakt.`,
      'Verwijderen',
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
      toast('Dit kan niet: het saldo zou onder nul komen.');
      return;
    }
    const sure = await ask(
      `${KIND[gone.kind]} van ${formatEuro(Math.abs(gone.delta))} verwijderen? Het saldo wordt ${formatEuro(after)}.`,
      'Verwijderen',
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

navigator.storage?.persist?.(); // ask the browser not to evict the cards
navigator.serviceWorker?.register('sw.js');
state = load();
render();
