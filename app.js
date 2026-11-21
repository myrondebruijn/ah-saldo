import {
  balance, cleanDigits, code128, daysLeft, expiryState, formatEuro, groupNumber, isDate, isoDate,
  needsInstall, parseEuro, parseState, settle, sortCards, validCode, validNumber,
} from './logic.js';

const KEY = 'ah-saldo';
// AH's official "Saldochecker AH cadeaukaart" link, as published on ah.nl
const CHECKER = 'https://service2.loyaltyinabox.com/CardBalanceChecker/2/paymentapi.aspx?cmd=showbalance&username=1379001&lang=nl-NL';
const KIND = { start: 'Beginsaldo', pay: 'Betaling', correct: 'Correctie' };

const $ = (id) => document.getElementById(id);
const app = $('app');
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let state;

// ---------- storage ----------

function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return { cards: [], needsBackup: false };
  try {
    return parseState(raw);
  } catch {
    // move the unreadable data to another key, so the next save cannot overwrite it
    localStorage.setItem(`${KEY}-onleesbaar-${Date.now()}`, raw);
    localStorage.removeItem(KEY);
    toast('De opgeslagen kaarten zijn onleesbaar. Zet een back-up terug.');
    return { cards: [], needsBackup: false };
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

// ---------- screens ----------
// Everything interpolated into HTML below is digits, a date, a generated id or fixed text:
// the forms and parseState let nothing else into the state.
// Each screen returns its HTML and, optionally, the buttons for the dock at the thumb.

const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const last4 = (card) => `•••• ${card.number.slice(-4)}`;
const formatDate = (iso, timeZone) =>
  new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', timeZone });
const signed = (delta) => `${delta < 0 ? '−' : '+'} ${formatEuro(Math.abs(delta))}`;

function expiryLabel(card) {
  if (!card.expiry) return '';
  const days = daysLeft(card.expiry, isoDate());
  if (days < 0) return `Verlopen op ${formatDate(card.expiry, 'UTC')}`;
  if (days === 0) return 'Verloopt vandaag';
  if (days <= 30) return `Verloopt over ${days} ${days === 1 ? 'dag' : 'dagen'}`;
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

function homeScreen() {
  const active = sortCards(state.cards.filter((card) => balance(card) > 0));
  const spent = state.cards.length - active.length;
  const total = active.reduce((sum, card) => sum + balance(card), 0);
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
        <p class="footnote">${active.length} ${active.length === 1 ? 'kaart' : 'kaarten'}</p>
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
      ${spent ? `
        <div class="group">
          <a class="row" href="#/archief"><span class="row-main">Lege kaarten</span> ${spent}${icon('next')}</a>
        </div>` : ''}
      <h2 class="section">Back-up</h2>
      <div class="group">
        <button class="row tint" data-action="export">Back-up maken</button>
        <button class="row tint" data-action="import">Terugzetten</button>
      </div>
      <p class="group-note">Je kaarten staan alleen op deze telefoon. Het back&#8209;upbestand bevat alle nummers
        en codes: bewaar het als contant geld.</p>`,
    // with cards the thumb button starts a payment; adding a card stays on the plus button above
    dock: active.length
      ? '<a class="button primary" href="#/betalen">Betalen</a>'
      : '<button class="button primary" data-action="add">Kaart toevoegen</button>',
  };
}

// ---------- paying at the till ----------
// One payment walks through the cards in the order to use them. Nothing is saved until it is finished.
// `queue` holds the card ids; `steps` has one entry per card already passed: true = the till emptied it, false = skipped.
let paying = null;

const cardById = (id) => state.cards.find((card) => card.id === id);
const payCard = () => cardById(paying.queue[paying.steps.length]); // undefined once every card is passed
const emptiedCards = () => paying.queue.filter((id, index) => paying.steps[index]).map(cardById);

function payScreen() {
  const card = payCard();
  const back = paying.steps.length
    ? `<button class="back" data-action="payBack">${icon('back')}Vorige</button>`
    : `<a class="back" href="#/">${icon('back')}Kaarten</a>`;
  if (!card) {
    const used = emptiedCards().length;
    return {
      html: `
        <header class="navbar">${back}<h1>Betalen</h1><span></span></header>
        ${blank('Geen kaarten meer', used ? 'Betaal de rest met pin.' : '')}`,
      dock: used ? '<button class="button primary" data-action="payRest">Klaar</button>' : '',
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

// Records a finished payment; `total` is what was due when the cards covered it, or null when a rest went by pin.
function finishPayment(cards, total) {
  const taken = settle(cards.map(balance), total);
  cards.forEach((card, index) => card.entries.push(newEntry('pay', -taken[index])));
  save();
  const sum = taken.reduce((all, cents) => all + cents, 0);
  toast(`${formatEuro(sum)} afgeschreven van ${cards.length} ${cards.length === 1 ? 'kaart' : 'kaarten'}.`);
  goHome();
}

function cardScreen(card) {
  const left = balance(card);
  const history = [...card.entries].reverse().map((entry) => `
    <li class="row">
      <span class="row-main">${KIND[entry.kind]} <small>${formatDate(entry.at)}</small></span>
      ${entry.kind === 'start' ? formatEuro(entry.delta) : signed(entry.delta)}
      ${entry.kind === 'start' ? '<span class="row-icon"></span>' : `
        <button class="row-icon" data-action="undo" data-entry="${entry.id}"
          aria-label="${KIND[entry.kind]} van ${formatEuro(Math.abs(entry.delta))} verwijderen">${icon('trash')}</button>`}
    </li>`).join('');
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
    dock: left > 0 ? `
      <button class="button" data-action="empty">Kaart is leeg</button>
      <button class="button primary" data-action="pay">Betaald</button>` : '',
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

function currentCard() {
  const [, name, id] = location.hash.split('/'); // "#/kaart/<id>"
  return name === 'kaart' ? state.cards.find((card) => card.id === id) : undefined;
}

// how deep the current address sits: list 0, archive or payment 1, card 2
const depth = () => (location.hash.startsWith('#/kaart/') ? 2 : ['#/archief', '#/betalen'].includes(location.hash) ? 1 : 0);
let shownDepth = 0;
let tapped = false; // true when a tap inside the app caused the navigation

function render() {
  const card = currentCard();
  // a payment lives only while its screen is open; it starts with the cards in the order to use them
  if (location.hash !== '#/betalen') paying = null;
  else paying ??= { queue: sortCards(state.cards.filter((each) => balance(each) > 0)).map((each) => each.id), steps: [] };
  const atTill = Boolean(card || paying?.queue.length); // the screens a till scanner reads stay white
  const screen = needsInstall(navigator.userAgent, standalone) ? installScreen()
    : card ? cardScreen(card)
    : atTill ? payScreen()
    : location.hash === '#/archief' ? archiveScreen()
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

// Changes the screen with an iPhone-style slide ('push' forward, 'pop' back) where the browser can.
function slide(nav, change) {
  if (!document.startViewTransition || reducedMotion.matches) {
    change();
    return;
  }
  document.documentElement.dataset.nav = nav;
  document.startViewTransition(change);
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

// Shows a dialog; resolves with how it closed: 'ok' once its form is submitted and `check` returns no error
// message, the value of another button that closed it, or '' when cancelled.
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
// `other` adds a second way out, { label, note }: a button that resolves with 'other' instead of an amount.
async function askAmount(title, label, check = () => '', other) {
  const form = $('amountDialog').querySelector('form');
  form.reset();
  $('amountTitle').textContent = title;
  $('amountLabel').textContent = label;
  $('amountOther').hidden = !other;
  $('amountOther').querySelector('button').textContent = other?.label ?? '';
  $('amountOther').querySelector('p').textContent = other?.note ?? '';
  let cents;
  const answer = await openDialog($('amountDialog'), () => {
    cents = parseEuro(form.elements.amount.value);
    return cents === null ? 'Vul een bedrag in, bijvoorbeeld 12,50.' : check(cents);
  });
  return answer === 'ok' ? cents : answer || null;
}

// ---------- actions ----------

const newEntry = (kind, delta) => ({ id: crypto.randomUUID(), at: new Date().toISOString(), kind, delta });

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

function spend(card, cents) {
  card.entries.push(newEntry('pay', -cents));
  save();
  toast(balance(card) > 0
    ? `${formatEuro(cents)} afgeschreven van ${last4(card)}.`
    : `${last4(card)} is leeg en staat bij Lege kaarten.`);
  goHome(); // back to the list, where the next card to use is on top
}

async function exportBackup() {
  const name = `ah-saldo-backup-${isoDate()}.json`;
  const json = JSON.stringify({ app: 'ah-saldo', version: 1, exportedAt: new Date().toISOString(), cards: state.cards }, null, 2);
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
    `Back-up met ${next.cards.length} kaarten terugzetten? Dit vervangt de ${state.cards.length} kaarten die nu in de app staan.`,
    'Terugzetten',
  );
  if (!sure) return;
  state = { cards: next.cards, needsBackup: false };
  save();
  goHome();
}

// Each action gets the card of the current screen (if any) and the element that was tapped.
const actions = {
  add: () => editCard(),
  edit: (card) => editCard(card),
  close: (card, button) => closeDialog(button.closest('dialog'), button.value), // Annuleren has no value

  // one step of a payment: the till emptied this card, it was skipped, or the last step is taken back
  payNext() { paying.steps.push(true); slide('push', show); },
  paySkip() { paying.steps.push(false); slide('push', show); },
  payBack() { paying.steps.pop(); slide('pop', show); },
  payRest: () => finishPayment(emptiedCards(), null),

  async payDone() {
    const cards = [...emptiedCards(), payCard()];
    const balances = cards.map(balance);
    const earlier = balances.slice(0, -1).reduce((sum, cents) => sum + cents, 0);
    const several = cards.length > 1;
    const answer = await askAmount('Afronden', 'Totaalbedrag (alles met kaarten betaald)', (total) => {
      const taken = settle(balances, total);
      if (taken === 'high') {
        return `Dat is meer dan er op ${several ? 'deze kaarten' : 'deze kaart'} stond (${formatEuro(earlier + balances.at(-1))}). Kies dan Rest met pin betaald.`;
      }
      if (taken === 'low') {
        return earlier ? `Dat dekten de vorige kaarten al (${formatEuro(earlier)}). Ga terug met Vorige.` : 'Vul een bedrag in, bijvoorbeeld 12,50.';
      }
      return '';
    }, { label: 'Rest met pin betaald', note: several ? 'Dan zijn alle gebruikte kaarten leeg.' : 'Dan is deze kaart leeg.' });
    if (answer !== null) finishPayment(cards, answer === 'other' ? null : answer);
  },
  export: exportBackup,
  import: () => $('importFile').click(),
  empty: (card) => spend(card, balance(card)),

  async pay(card) {
    const left = balance(card);
    const cents = await askAmount('Betaald', 'Bedrag van deze kaart', (amount) => {
      if (amount === 0) return 'Vul een bedrag in, bijvoorbeeld 12,50.';
      if (amount > left) return `Dat is meer dan het saldo van ${formatEuro(left)}.`;
      return '';
    });
    if (cents !== null) spend(card, cents);
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
