import {
  balance, cleanDigits, daysLeft, expiryState, formatEuro, groupNumber, isDate, isoDate,
  needsInstall, parseEuro, parseState, sortCards, validCode, validNumber,
} from './logic.js';

const KEY = 'ah-saldo';
// AH's official "Saldochecker AH cadeaukaart" link, as published on ah.nl
const CHECKER = 'https://service2.loyaltyinabox.com/CardBalanceChecker/2/paymentapi.aspx?cmd=showbalance&username=1379001&lang=nl-NL';
const KIND = { start: 'Beginsaldo', pay: 'Betaling', correct: 'Correctie' };

const $ = (id) => document.getElementById(id);
const app = $('app');
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;

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

// ---------- views ----------
// Everything interpolated into HTML below is digits, a date, a generated id or fixed text:
// the forms and parseState let nothing else into the state.

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

const tile = (card) => `
  <li><a class="tile ${balance(card) > 0 ? expiryState(card.expiry, isoDate()) : 'spent'}" href="#/kaart/${card.id}">
    <span>${last4(card)}</span>
    <span class="tile-balance">${formatEuro(balance(card))}</span>
    <span class="tile-expiry">${expiryLabel(card)}</span>
  </a></li>`;

function homeView() {
  const active = sortCards(state.cards.filter((card) => balance(card) > 0));
  const spent = state.cards.length - active.length;
  const total = active.reduce((sum, card) => sum + balance(card), 0);
  return `
    <header>
      <h1>AH Saldo</h1>
      <p class="total">${formatEuro(total)}</p>
      <p class="muted">${active.length} ${active.length === 1 ? 'kaart' : 'kaarten'}</p>
    </header>
    ${state.needsBackup ? `
      <p class="notice">Je hebt nieuwe kaarten zonder back-up.
        <button data-action="export">Back-up maken</button></p>` : ''}
    ${active.length
      ? `<ul class="tiles">${active.map(tile).join('')}</ul>`
      : '<p class="blank">Nog geen kaarten. Voeg je eerste AH cadeaukaart toe.</p>'}
    <button class="primary wide" data-action="add">Kaart toevoegen</button>
    ${spent ? `<a class="link" href="#/archief">Lege kaarten (${spent})</a>` : ''}
    <section class="backup">
      <h2>Back-up</h2>
      <p class="muted">Je kaarten staan alleen op deze telefoon. Het back-upbestand bevat alle nummers
        en codes: bewaar het als contant geld.</p>
      <div class="row">
        <button data-action="export">Back-up maken</button>
        <button data-action="import">Terugzetten</button>
      </div>
    </section>`;
}

function cardView(card) {
  const left = balance(card);
  const history = [...card.entries].reverse().map((entry) => `
    <li>
      <span>${KIND[entry.kind]}<small>${formatDate(entry.at)}</small></span>
      <span class="amount">${entry.kind === 'start' ? formatEuro(entry.delta) : signed(entry.delta)}</span>
      ${entry.kind === 'start' ? '<span></span>' : `
        <button class="icon" data-action="undo" data-entry="${entry.id}"
          aria-label="${KIND[entry.kind]} van ${formatEuro(Math.abs(entry.delta))} verwijderen">✕</button>`}
    </li>`).join('');
  return `
    <a class="link" href="${left > 0 ? '#/' : '#/archief'}">‹ ${left > 0 ? 'Kaarten' : 'Lege kaarten'}</a>
    <h1>Kaart ${last4(card)}</h1>
    <dl class="pass">
      <dt>Kaartnummer</dt>
      <dd class="number">${groupNumber(card.number)}</dd>
      <dt>Beveiligingscode</dt>
      <dd class="code">${card.code}</dd>
    </dl>
    <p class="total">${formatEuro(left)}</p>
    <p class="expiry ${expiryState(card.expiry, isoDate())}">${expiryLabel(card)}</p>
    <div class="actions">
      ${left > 0 ? `
        <button class="primary wide" data-action="pay">Betaald</button>
        <button data-action="empty">Kaart is leeg</button>`
      : '<p class="muted wide">Deze kaart is leeg en staat bij Lege kaarten.</p>'}
      <button data-action="check">Saldo checken</button>
      <button data-action="correct">Saldo corrigeren</button>
      <button data-action="edit">Bewerken</button>
      <button class="danger" data-action="delete">Verwijderen</button>
    </div>
    <h2>Geschiedenis</h2>
    <ul class="history">${history}</ul>`;
}

function archiveView() {
  const spent = state.cards.filter((card) => balance(card) <= 0);
  return `
    <a class="link" href="#/">‹ Kaarten</a>
    <h1>Lege kaarten</h1>
    ${spent.length ? `<ul class="tiles">${spent.map(tile).join('')}</ul>` : '<p class="blank">Geen lege kaarten.</p>'}`;
}

const installView = () => `
  <section class="install">
    <h1>AH Saldo</h1>
    <h2>Zet de app eerst op je beginscherm</h2>
    <p>Safari kan de gegevens van een website na een week zonder gebruik wissen. Op je beginscherm
      blijven je kaarten bewaard.</p>
    <ol>
      <li>Tik in Safari op <strong>Deel</strong> (het vierkant met de pijl omhoog).</li>
      <li>Kies <strong>Zet op beginscherm</strong>.</li>
      <li>Open AH Saldo vanaf je beginscherm.</li>
    </ol>
  </section>`;

function currentCard() {
  const [, name, id] = location.hash.split('/'); // "#/kaart/<id>"
  return name === 'kaart' ? state.cards.find((card) => card.id === id) : undefined;
}

function render() {
  const card = currentCard();
  document.body.classList.toggle('pay', Boolean(card));
  app.innerHTML = needsInstall(navigator.userAgent, standalone) ? installView()
    : card ? cardView(card)
    : location.hash === '#/archief' ? archiveView()
    : homeView();
}

// ---------- dialogs ----------

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 4000);
}

// Shows a dialog; resolves true once its form is submitted and `check` returns no error message.
function openDialog(dialog, check = () => '') {
  const error = dialog.querySelector('.error');
  if (error) error.textContent = '';
  return new Promise((resolve) => {
    dialog.querySelector('form').onsubmit = (event) => {
      const message = check();
      if (!message) return;
      event.preventDefault();
      error.textContent = message;
    };
    dialog.onclose = () => resolve(dialog.returnValue === 'ok');
    dialog.returnValue = '';
    dialog.showModal();
  });
}

function ask(text, okLabel) {
  $('confirmText').textContent = text;
  $('confirmOk').textContent = okLabel;
  return openDialog($('confirmDialog'));
}

// Resolves with the entered amount in cents, or null when cancelled.
async function askAmount(title, label, check = () => '') {
  const form = $('amountDialog').querySelector('form');
  form.reset();
  $('amountTitle').textContent = title;
  $('amountLabel').textContent = label;
  let cents;
  const ok = await openDialog($('amountDialog'), () => {
    cents = parseEuro(form.elements.amount.value);
    return cents === null ? 'Vul een bedrag in, bijvoorbeeld 12,50.' : check(cents);
  });
  return ok ? cents : null;
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
  const ok = await openDialog($('cardDialog'), () => {
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
  if (!ok) return;
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
  location.hash = '#/'; // back to the list, where the next card to use is on top
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
  location.hash = '#/';
}

// Each action gets the card of the current screen (if any) and the element that was tapped.
const actions = {
  add: () => editCard(),
  edit: (card) => editCard(card),
  close: (card, button) => button.closest('dialog').close(),
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
    location.hash = '#/';
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
  const target = event.target.closest('[data-action]');
  if (target) actions[target.dataset.action](currentCard(), target);
});
$('importFile').addEventListener('change', importBackup);
addEventListener('hashchange', () => {
  render();
  scrollTo(0, 0);
  app.focus(); // lets screen readers and keyboards start at the new screen
});

navigator.storage?.persist?.(); // ask the browser not to evict the cards
navigator.serviceWorker?.register('sw.js');
state = load();
render();
