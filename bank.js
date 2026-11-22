// Pure logic for the bank side of Kassa: reading bank files, sorting transactions into categories and
// working out the household figures. No DOM and no storage, so bank.test.mjs can run it in Node.
// Dates are 'YYYY-MM-DD' strings and months 'YYYY-MM', so they compare as text. Amounts are cents.

import { isDate, isName, isoDate } from './logic.js';

export const US = 'Wij'; // the household itself, in "Voor wie?"

// The categories every phone starts with. Their ids are fixed, because the figures below count on some of them.
// kind: 'out' = spending, 'in' = income, 'none' = money that only moves (between own accounts).
export const START_CATS = [
  { id: 'boodschappen', name: 'Boodschappen', kind: 'out' },
  { id: 'uiteten', name: 'Uit eten', kind: 'out' },
  { id: 'fun', name: 'Fun money', kind: 'out' },
  { id: 'abonnementen', name: 'Abonnementen', kind: 'out' },
  { id: 'auto', name: 'Auto & vervoer', kind: 'out' },
  { id: 'verzekering', name: 'Verzekering & zorg', kind: 'out' },
  { id: 'winkelen', name: 'Winkelen', kind: 'out' },
  { id: 'cadeaukaarten', name: 'Cadeaukaarten', kind: 'out' },
  { id: 'reizen', name: 'Reizen', kind: 'out' },
  { id: 'anderen', name: 'Voor anderen', kind: 'out' },
  { id: 'overig', name: 'Overig', kind: 'out' },
  { id: 'salaris', name: 'Salaris', kind: 'in' },
  { id: 'inkomen', name: 'Overig inkomen', kind: 'in' },
  { id: 'overboeking', name: 'Overboeking', kind: 'none' },
];
const KINDS = ['out', 'in', 'none'];

export const emptyBank = () => ({ accounts: [], txs: [], cats: START_CATS.map((cat) => ({ ...cat })), rules: {}, fixed: {}, since: '' });

// ---------- reading bank files ----------

const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// Bank exports come as UTF-8 or as Windows-1252 (the Rabo account export); valid UTF-8 is read as UTF-8.
export function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// A CSV file as rows of fields. A quoted field may hold commas, line breaks and "" for one quote.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0]) rows.push(row);
    row = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') endRow();
    else if (char !== '\r') field += char;
  }
  if (field || row.length) endRow();
  return rows;
}

// "-2.058,80", "+1897,72" or "12" -> cents; anything else -> null
export function bankCents(text) {
  const match = /^([+-]?)(\d+)(?:,(\d{1,2}))?$/.exec(String(text).trim().replace(/\./g, ''));
  if (!match) return null;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  return match[1] === '-' ? -cents : cents;
}

// One object per line of a CSV file, with the names of its first line
const table = (rows) => rows.slice(1).map((row) => Object.fromEntries(rows[0].map((head, index) => [head, row[index] ?? ''])));

// Every reader returns { accounts, txs } or throws: a file that cannot be read whole is not read at all.
const broken = () => new Error('broken');
function checked(file) {
  if (!file.txs.length || !file.txs.every(isTx) || !file.accounts.every(isAccount)) throw broken();
  return file;
}

// The Rabo export of a current or savings account ("CSV_A_..."). Each line has a sequence number per account
// (Volgnr), which is what tells a line apart from an equal one on the same day.
function readRabo(rows) {
  const accounts = new Map();
  const before = new Map(); // per account: the line read last, to check the balances against
  const txs = table(rows).map((row) => {
    const acc = row['IBAN/BBAN'];
    const seq = Number(row.Volgnr);
    const cents = bankCents(row.Bedrag);
    const after = bankCents(row['Saldo na trn']);
    const last = before.get(acc);
    if (last && seq === last.seq + 1 && last.after + cents !== after) throw broken();
    before.set(acc, { seq, after });
    if (!(accounts.get(acc)?.seq > seq)) accounts.set(acc, { seq, account: { id: acc, name: `Rabo ${acc.slice(-4)}`, bank: 'Rabo', balance: after } });
    const name = tidy(row['Naam tegenpartij']);
    const text = tidy(`${row['Omschrijving-1']} ${row['Omschrijving-2']} ${row['Omschrijving-3']}`);
    return {
      id: `${acc}.${seq}`, acc, date: row.Datum, cents,
      name: (name || text || '?').slice(0, 60), text: text.slice(0, 100),
      ...(row['Tegenrekening IBAN/BBAN'] && { iban: row['Tegenrekening IBAN/BBAN'] }),
      ...(row.Code === 'cc' && { own: true }), // 'cc' is paying off the credit card
    };
  });
  return checked({ accounts: [...accounts.values()].map((each) => each.account), txs });
}

// The Rabo export of a credit card ("RA_CC_..."). Each line has its own reference; there is no balance.
function readCard(rows) {
  const accounts = new Map();
  const txs = table(rows).map((row) => {
    const acc = `CC${row['Creditcard Nummer']}`;
    accounts.set(acc, { id: acc, name: tidy(row.Productnaam).slice(0, 30).trim() || acc, bank: 'Rabo', card: true });
    const name = tidy(row.Omschrijving);
    return {
      id: `${acc}.${row.Transactiereferentie}`, acc, date: row.Datum, cents: bankCents(row.Bedrag),
      name: (name || '?').slice(0, 60),
      text: row['Oorspr munt'] ? `${row['Oorspr bedrag']} ${row['Oorspr munt']}` : '',
      // topping the card up and settling the last statement are the other side of the account's 'cc' lines
      ...(/^(bijschrijving saldo|verrekening vorig overzicht)/i.test(name) && { own: true }),
    };
  });
  return checked({ accounts: [...accounts.values()], txs });
}

export function readCsv(text) {
  const rows = parseCsv(text);
  if (rows[0]?.[0] === 'IBAN/BBAN' && rows[0].includes('Volgnr')) return readRabo(rows);
  if (rows[0]?.includes('Creditcard Nummer')) return readCard(rows);
  throw new Error('unknown');
}

// a short fingerprint of a text (FNV-1a), to tell otherwise equal lines apart
function hash(text) {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
  return (value >>> 0).toString(36);
}

const sameWords = (a, b) => a.toLowerCase().split(' ').sort().join(' ') === b.toLowerCase().split(' ').sort().join(' ');

// The Openbank statement, a PDF. `items` are its pieces of text with their place: { page, x, y, str }.
// The statement is a table: a line has two dates, an amount and the balance at one height, and a description
// between them that may run over several lines around that height. Lines carry no number, so equal lines on
// one day are told apart by counting them.
export function readOpenbank(items) {
  const texts = items.map((item) => ({ ...item, str: tidy(item.str) })).filter((item) => item.str);
  const find = (pattern) => texts.find((item) => pattern.test(item.str))?.str;
  const iban = find(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/);
  const closing = find(/^-?\d+\.\d{1,2} EUR$/);
  if (!iban || !closing || !find(/^Open ?Bank/i)) throw new Error('unknown');
  const near = (a, b) => a.page === b.page && Math.abs(a.y - b.y) < 1.5;
  const label = (word) => texts.find((item) => item.str === word);
  const holder = label('Houder:') && texts.find((item) => item !== label('Houder:') && near(item, label('Houder:')))?.str;
  const heads = texts.filter((item) => item.str === 'Valutadatum'); // the column titles, once per page
  const isDay = (item) => /^\d{4}-\d{2}-\d{2}$/.test(item.str);
  const isAmount = (item) => /^-?\d+\.\d{1,2}$/.test(item.str);
  const toCents = (text) => Math.round(Number(text) * 100);

  const lines = [];
  for (const first of texts.filter(isDay)) {
    const level = texts.filter((item) => near(item, first)).sort((a, b) => a.x - b.x);
    const days = level.filter(isDay); // not level[0]: the small print at the foot of a page can be at a line's height
    if (days[0] !== first) continue; // the second date of a line
    const amounts = level.filter(isAmount).slice(-2); // the amount and the balance are the last two
    if (days.length !== 2 || amounts.length !== 2) throw broken();
    lines.push({ ...first, left: days[1].x + 20, right: amounts[0].x, cents: toCents(amounts[0].str), after: toCents(amounts[1].str), words: [] });
  }
  for (const item of texts) {
    if (isDay(item) || heads.some((head) => near(head, item))) continue;
    const line = lines.filter((each) => each.page === item.page && item.x > each.left && item.x < each.right)
      .sort((a, b) => Math.abs(a.y - item.y) - Math.abs(b.y - item.y))[0];
    if (line && Math.abs(line.y - item.y) <= 20) line.words.push(item);
  }
  // the statement lists the newest line first; every balance must follow from the line before it
  lines.reverse();
  lines.forEach((line, index) => {
    if (index && lines[index - 1].after + line.cents !== line.after) throw broken();
  });
  if (!lines.length || lines.at(-1).after !== toCents(closing.replace(' EUR', ''))) throw broken();

  const seen = new Map();
  const txs = lines.map((line) => {
    const concept = tidy(line.words.sort((a, b) => b.y - a.y || a.x - b.x).map((item) => item.str).join(' '));
    const match = /^(?:ONMIDDELLIJKE )?OVERBOEKING (?:VAN|TEN GUNSTE VAN) (.+?)(?:,? REFERENTIE ?(.*))?$/.exec(concept);
    const name = (match?.[1] ?? concept) || '?';
    const mark = `${line.str}.${line.cents}.${line.after}.${hash(concept)}`;
    seen.set(mark, (seen.get(mark) ?? -1) + 1);
    return {
      id: `${iban}.${mark}.${seen.get(mark)}`, acc: iban, date: line.str, cents: line.cents,
      name: name.slice(0, 60), text: (match?.[2] ?? '').slice(0, 100),
      ...(holder && sameWords(name, holder) && { own: true }), // to or from another account of the same person
    };
  });
  return checked({
    accounts: [{ id: iban, name: `Openbank ${iban.slice(-4)}`, bank: 'Openbank', balance: lines.at(-1).after, ...(holder && { holder: holder.slice(0, 30) }) }],
    txs,
  });
}

// Adds what a file holds to the saved bank data and returns how many of its transactions were new.
// A transaction that is already there (same id) is left alone, so files may overlap or be read twice.
export function addFile(bank, file, now) {
  const known = new Set(bank.txs.map((tx) => tx.id));
  const fresh = file.txs.filter((tx) => !known.has(tx.id));
  bank.txs.push(...fresh);
  for (const { balance, ...account } of file.accounts) {
    const through = file.txs.filter((tx) => tx.acc === account.id).reduce((latest, tx) => (tx.date > latest ? tx.date : latest), '');
    let saved = bank.accounts.find((each) => each.id === account.id);
    if (!saved) bank.accounts.push(saved = { ...account, through: '' });
    saved.uploaded = now;
    // the balance in the file is the newest we know when the file runs later, or as late with more lines
    const newer = through > saved.through || (through === saved.through && fresh.some((tx) => tx.acc === account.id));
    if (newer) Object.assign(saved, { through }, balance !== undefined && { balance });
  }
  return fresh.length;
}

// A Rabo account numbers its lines without skipping: true when lines between the first and last are missing.
export function hasGap(bank, account) {
  if (account.bank !== 'Rabo' || account.card) return false;
  const numbers = bank.txs.filter((tx) => tx.acc === account.id).map((tx) => Number(tx.id.split('.').pop()));
  return numbers.length > 0 && Math.max(...numbers) - Math.min(...numbers) + 1 !== numbers.length;
}

// ---------- categories ----------

// What a rule remembers of a counterparty's name: lower case, without numbers (a shop's branch) and marks.
export const ruleKey = (name) => name.toLowerCase().replace(/[^a-zà-ÿ]+/g, ' ').trim();

// Counterparties sorted without a rule of the user's: the supermarket chains, the chains to eat at, the
// subscriptions every household knows (streaming, phone and internet), the train and the bus (a trip paid with
// a bank card comes with a name of its own, "NLOV" and a code), and the shop the gift cards come from.
const KNOWN = [
  [/^((bck|ccv|sumup|zettle) )?(albert heijn|ah|jumbo|lidl|aldi|plus|dirk vdbroek|dirk van den broek|hoogvliet|coop|spar|picnic|vomar|dekamarkt|nettorama|sligro)( |$)/, 'boodschappen'],
  [/^((bck|ccv|sumup|zettle) )?(mcdonald s|mcdonalds|mc donalds|kfc|burger king|subway|domino s|dominos|new york pizza|thuisbezorgd|takeaway com|uber eats|starbucks|febo|sushipoint)( |$)/, 'uiteten'],
  [/^(ns groep|ns reizigers|nlov[a-z]*|ov chipkaart)( |$)/, 'auto'],
  [/^(spotify|netflix|disney plus|hbo max|help hbomax|videoland|amazon prime|youtube premium|apple com bill|openai|odido|youfone|kpn|vodafone|ziggo|simyo|lebara)( |$)/, 'abonnementen'],
  [/^wissel (nederland|nl)( |$)/, 'cadeaukaarten'],
];
// a payment request from a person named like a shop ("Plus via Tikkie") is nobody's groceries
const known = (key) => (key.includes('tikkie') ? undefined : KNOWN.find(([pattern]) => pattern.test(key))?.[1]);

// Returns the function that gives a transaction's category id, or '' while it still has to be sorted:
// the choice for that one transaction, else the rule for its counterparty, else what the app can tell itself.
export function sorter(bank) {
  const own = new Set(bank.accounts.map((account) => account.id));
  const cats = new Set(bank.cats.map((cat) => cat.id));
  return (tx) => {
    const key = ruleKey(tx.name);
    const cat = tx.cat ?? bank.rules[key]
      ?? (tx.own || own.has(tx.iban) ? 'overboeking' : known(key));
    return cats.has(cat) ? cat : '';
  };
}

// ---------- figures ----------

export const monthOf = (date) => date.slice(0, 7);
// the month `by` months after (or, negative, before) 'YYYY-MM'
export function shiftMonth(month, by) {
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + by, 1);
  return isoDate(date).slice(0, 7);
}

// Groceries can be split between people: `shares` ([{ who, cents }]) on a gift card payment, and on a bank
// transaction that is sorted as groceries. The household's own part stays groceries; what was for others
// counts under "Voor anderen".
const forOthers = (shares) => (shares ?? []).reduce((sum, share) => sum + (share.who === US ? 0 : share.cents), 0);

// The one shop whose gift cards the app holds itself. Buying one moves money onto a card, so it is not
// spending: the money counts as groceries when the card pays at the till. Cards for other shops are spent
// as far as the app can tell, and count on the day they are bought.
export const AH = 'Albert Heijn';
const onCard = (tx, cat) => cat === 'cadeaukaarten' && tx.gift?.shop === AH;

// What a gift card payment adds to the figures: only the part the cards paid, because the pin part is on the
// bank statement. A share for someone else comes out of the card part first.
function cardParts(purchase) {
  const others = Math.min(purchase.cards, forOthers(purchase.shares));
  return [['boodschappen', purchase.cards - others], ['anderen', others]];
}

// What came in and went out from `from` up to (not including) `to`, never earlier than bank.since:
// income, spending, how many transactions are not sorted yet, and `byCat`: category id -> cents
// (spent for a spending category, received for an income one; '' holds what is not sorted yet).
// Money back in a spending category lowers what was spent there. Unsorted money counts by its sign.
export function figures(bank, purchases, from, to) {
  const catOf = sorter(bank);
  const kinds = new Map(bank.cats.map((cat) => [cat.id, cat.kind]));
  const start = from > bank.since ? from : bank.since;
  const byCat = new Map();
  const result = { income: 0, spending: 0, open: 0, byCat };
  const add = (cat, cents) => byCat.set(cat, (byCat.get(cat) ?? 0) + cents);
  for (const tx of bank.txs) {
    if (tx.date < start || tx.date >= to) continue;
    const cat = catOf(tx);
    const kind = !cat ? (tx.cents < 0 ? 'out' : 'in') : onCard(tx, cat) ? 'none' : kinds.get(cat);
    if (!cat) result.open++;
    if (kind === 'out') {
      const others = cat === 'boodschappen' ? forOthers(tx.shares) : 0;
      result.spending -= tx.cents;
      add(cat, -tx.cents - others);
      if (others) add('anderen', others);
    }
    if (kind === 'in') { result.income += tx.cents; add(cat, tx.cents); }
  }
  for (const purchase of purchases) {
    const date = isoDate(new Date(purchase.at));
    if (date < start || date >= to) continue;
    for (const [cat, cents] of cardParts(purchase)) {
      if (cents) { result.spending += cents; add(cat, cents); }
    }
  }
  return result;
}

// Who the groceries from `from` up to `to` were for: [name, cents], the largest first. It covers what the bank
// shows as groceries and the part of a gift card payment that the cards paid.
export function forWhom(bank, purchases, from, to) {
  const catOf = sorter(bank);
  const start = from > bank.since ? from : bank.since;
  const sums = new Map();
  const add = (who, cents) => sums.set(who, (sums.get(who) ?? 0) + cents);
  for (const tx of bank.txs) {
    if (tx.date < start || tx.date >= to || catOf(tx) !== 'boodschappen') continue;
    for (const share of tx.shares ?? []) if (share.who !== US) add(share.who, share.cents);
    add(US, -tx.cents - forOthers(tx.shares));
  }
  for (const purchase of purchases) {
    const date = isoDate(new Date(purchase.at));
    if (date < start || date >= to) continue;
    let left = purchase.cards; // a share for someone else comes out of the card part first, as in the figures
    for (const share of purchase.shares) {
      const cents = share.who === US ? 0 : Math.min(left, share.cents);
      if (cents) add(share.who, cents);
      left -= cents;
    }
    add(US, left);
  }
  return [...sums].filter(([, cents]) => cents !== 0).sort((a, b) => b[1] - a[1]);
}

// The transactions of one category ('' = not sorted yet) from `from` up to `to`, newest first.
export function inCategory(bank, cat, from, to) {
  const catOf = sorter(bank);
  const start = from > bank.since ? from : bank.since;
  return bank.txs.filter((tx) => tx.date >= start && tx.date < to && catOf(tx) === cat)
    .sort((a, b) => b.date.localeCompare(a.date));
}

// Transactions per counterparty: [{ key, name, cents, count }], the largest amount first.
export function byParty(txs) {
  const parties = new Map();
  for (const tx of txs) {
    const key = ruleKey(tx.name);
    const party = parties.get(key) ?? { key, name: tx.name, cents: 0, count: 0 };
    party.cents += tx.cents;
    party.count++;
    parties.set(key, party);
  }
  return [...parties.values()].sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
}

// ---------- gift cards ----------
// A payment for gift cards can say what it bought: tx.gift = { shop, value }, the shop the cards are for and
// what they are worth together. What they are worth above what was paid is what the cards saved.

const byDate = (a, b) => a.date.localeCompare(b.date);

// The gift cards bought from `from` up to `to`, never earlier than bank.since, per shop:
// [{ shop, value, paid, count }], the largest value first.
export function giftsBought(bank, from, to) {
  const start = from > bank.since ? from : bank.since;
  const shops = new Map();
  for (const tx of bank.txs) {
    if (!tx.gift || tx.date < start || tx.date >= to) continue;
    const shop = shops.get(tx.gift.shop) ?? { shop: tx.gift.shop, value: 0, paid: 0, count: 0 };
    shop.value += tx.gift.value;
    shop.paid -= tx.cents;
    shop.count++;
    shops.set(tx.gift.shop, shop);
  }
  return [...shops.values()].sort((a, b) => b.value - a.value);
}

// The payments in the gift card category that do not say yet what they bought, the newest first.
// A payment that came back (the same amount, on that day or later) bought nothing, so it is not in the list.
export function giftsToFill(bank) {
  const catOf = sorter(bank);
  const blank = bank.txs.filter((tx) => !tx.gift && catOf(tx) === 'cadeaukaarten').sort(byDate);
  const open = blank.filter((tx) => tx.cents < 0);
  for (const back of blank.filter((tx) => tx.cents > 0)) {
    const index = open.findLastIndex((tx) => tx.cents === -back.cents && tx.date <= back.date);
    if (index >= 0) open.splice(index, 1);
  }
  return open.reverse();
}

// What a payment of `paid` cents probably bought: every shop cards were bought for before, each with the value
// its last discount gives, the likeliest shop first. A value that lands on whole fives of euros speaks for a
// shop, and the nearer the better; a discount that moved a little still lands there.
export function giftGuesses(bank, paid) {
  const rates = new Map(); // shop -> what a euro of card cost the last time, the shop bought last at the end
  for (const tx of [...bank.txs].sort(byDate)) {
    if (!tx.gift) continue;
    const rate = -tx.cents / tx.gift.value;
    // more than a quarter off is no discount: part was paid some other way (points, another card), so it says nothing about the price
    const usual = rate >= 0.75 && rate <= 1 ? rate : rates.get(tx.gift.shop) ?? 1;
    rates.delete(tx.gift.shop);
    rates.set(tx.gift.shop, usual);
  }
  return [...rates].reverse().map(([shop, rate]) => {
    const exact = paid / rate;
    const round = Math.round(exact / 500) * 500;
    const near = round > 0 && Math.abs(exact - round) <= round * 0.015;
    return { shop, value: near ? round : Math.round(exact / 5) * 5, off: near ? Math.abs(exact - round) : 1e9 };
  }).sort((a, b) => a.off - b.off).map(({ shop, value }) => ({ shop, value }));
}

// ---------- fixed costs ----------
// A fixed cost is a counterparty that is paid every month. bank.fixed holds the user's answer per rule key:
// true = it is one, false = it was suggested and declined.

// per counterparty and month, the payments made: key -> { name, months: 'YYYY-MM' -> [cents paid, ...] }
function payments(bank) {
  const catOf = sorter(bank);
  const kinds = new Map(bank.cats.map((cat) => [cat.id, cat.kind]));
  const parties = new Map();
  for (const tx of [...bank.txs].sort((a, b) => a.date.localeCompare(b.date))) {
    if (tx.cents >= 0 || (kinds.get(catOf(tx)) ?? 'out') !== 'out') continue;
    const key = ruleKey(tx.name);
    const party = parties.get(key) ?? { name: tx.name, months: new Map() };
    party.name = tx.name;
    party.months.set(monthOf(tx.date), [...(party.months.get(monthOf(tx.date)) ?? []), -tx.cents]);
    parties.set(key, party);
  }
  return parties;
}

const total = (list) => (list ?? []).reduce((sum, cents) => sum + cents, 0);

// Counterparties that were paid exactly once in each of the three months before `month`, and that the user
// has not decided on yet: [{ key, name, cents }], the largest first.
export function fixedSuggestions(bank, month) {
  const last3 = [1, 2, 3].map((back) => shiftMonth(month, -back));
  return [...payments(bank)]
    .filter(([key, party]) => !(key in bank.fixed) && last3.every((each) => party.months.get(each)?.length === 1))
    .map(([key, party]) => ({ key, name: party.name, cents: total(party.months.get(last3[0])) }))
    .sort((a, b) => b.cents - a.cents);
}

// The fixed costs in `month`: [{ key, name, expected, paid }], the largest first. `expected` is what the
// last earlier month with a payment cost (0 when there is none); `paid` is this month's, 0 while it is still to come.
export function fixedCosts(bank, month) {
  const parties = payments(bank);
  return Object.keys(bank.fixed).filter((key) => bank.fixed[key] && parties.has(key)).map((key) => {
    const { name, months } = parties.get(key);
    const earlier = [...months.keys()].filter((each) => each < month).sort().at(-1);
    return { key, name, expected: total(months.get(earlier)), paid: total(months.get(month)) };
  }).sort((a, b) => (b.expected || b.paid) - (a.expected || a.paid));
}

// ---------- balances ----------

// An account's balance at the end of `date`: the newest balance known, less everything booked after that day.
// A credit card has no balance in its file; there it is the sum of all its lines.
// shortcut: this counts on the card's lines being complete from its first day; ask for the balance if a card ever starts halfway.
export function balanceOn(bank, account, date = '9999') {
  const lines = bank.txs.filter((tx) => tx.acc === account.id);
  const now = account.balance ?? lines.reduce((sum, tx) => sum + tx.cents, 0);
  return now - lines.reduce((sum, tx) => sum + (tx.date > date ? tx.cents : 0), 0);
}

// What all gift cards together held at the end of `date`
export const cardsOn = (cards, date) => cards.reduce((sum, card) =>
  sum + card.entries.reduce((held, entry) => held + (isoDate(new Date(entry.at)) <= date ? entry.delta : 0), 0), 0);

// ---------- saved data ----------

const isId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
const isText = (text, max) => typeof text === 'string' && text.length <= max && !/[\u0000-\u001f]/.test(text);
const isGift = (gift) => isName(gift?.shop) && Number.isInteger(gift.value) && gift.value > 0;
const isTx = (tx) => typeof tx?.id === 'string' && /^[\w.-]{1,120}$/.test(tx.id) && isId(tx.acc) && isDate(tx.date)
  && Number.isInteger(tx.cents) && isText(tx.name, 60) && tx.name.length > 0 && isText(tx.text ?? '', 100)
  && (tx.iban === undefined || /^[A-Z0-9]{1,34}$/.test(tx.iban))
  && (tx.own === undefined || tx.own === true) && (tx.cat === undefined || isId(tx.cat))
  // shares split money that went out, name by name, and add up to all of it
  && (tx.shares === undefined || (tx.cents < 0 && Array.isArray(tx.shares) && tx.shares.length > 0
    && tx.shares.every((share) => isName(share?.who) && Number.isInteger(share.cents) && share.cents > 0)
    && tx.shares.reduce((sum, share) => sum + share.cents, 0) === -tx.cents))
  && (tx.gift === undefined || (tx.cents < 0 && isGift(tx.gift)));
const isAccount = (account) => isId(account?.id) && isName(account.name) && isText(account.bank ?? '', 20)
  && (account.balance === undefined || Number.isInteger(account.balance))
  && (account.holder === undefined || isText(account.holder, 30)) && (account.card === undefined || account.card === true);
const isSaved = (account) => isAccount(account) && (account.through === '' || isDate(account.through))
  && typeof account.uploaded === 'string' && !Number.isNaN(Date.parse(account.uploaded));
const isCat = (cat) => isId(cat?.id) && isName(cat.name) && KINDS.includes(cat.kind)
  && (cat.budget === undefined || (Number.isInteger(cat.budget) && cat.budget > 0));
const isRules = (rules, isValue) => typeof rules === 'object' && rules !== null && !Array.isArray(rules)
  && Object.entries(rules).every(([key, value]) => isText(key, 60) && key.length > 0 && isValue(value));

// Reads saved bank data, or the bank part of a backup. Throws on anything that is not exactly our shape,
// because names and descriptions end up on screen.
export function parseBank(data) {
  const ok = Array.isArray(data?.accounts) && data.accounts.every(isSaved)
    && Array.isArray(data.txs) && data.txs.every(isTx)
    && Array.isArray(data.cats) && data.cats.every(isCat) && new Set(data.cats.map((cat) => cat.id)).size === data.cats.length
    && isRules(data.rules, isId) && isRules(data.fixed, (value) => typeof value === 'boolean')
    && (data.since === '' || isDate(data.since));
  if (!ok) throw new Error('invalid bank data');
  return {
    accounts: data.accounts.map(({ id, name, bank, balance, holder, card, through, uploaded }) => ({
      id, name, bank: bank ?? '', through, uploaded,
      ...(balance !== undefined && { balance }), ...(holder && { holder }), ...(card && { card }),
    })),
    txs: data.txs.map(({ id, acc, date, cents, name, text, iban, own, cat, shares, gift }) => ({
      id, acc, date, cents, name, text: text ?? '', ...(iban && { iban }), ...(own && { own }), ...(cat && { cat }),
      ...(shares && { shares: shares.map(({ who, cents: part }) => ({ who, cents: part })) }),
      ...(gift && { gift: { shop: gift.shop, value: gift.value } }),
    })),
    cats: data.cats.map(({ id, name, kind, budget }) => ({ id, name, kind, ...(budget && { budget }) })),
    rules: { ...data.rules }, fixed: { ...data.fixed }, since: data.since,
  };
}

// A starter file: everything prepared outside the app, added to what is there. It may hold bank files that
// were read already (`files`, each as a reader returns it, read at the moment `at`), and categories, rules,
// choices, names and gift cards: { files, at, cats, rules, fixed, since, names: account id -> name,
// choices: transaction id -> category id, gifts: transaction id -> { shop, value } }
// Returns how many transactions were new, or null, changing nothing, when the file is not that.
export function addStarter(bank, starter, now) {
  const { files = [], at = now, cats = [], rules = {}, fixed = {}, since = '', names = {}, choices = {}, gifts = {} } = starter ?? {};
  const ok = starter?.kind === 'kassa-start' && Array.isArray(cats) && cats.every(isCat)
    && isRules(rules, isId) && isRules(fixed, (value) => typeof value === 'boolean') && (since === '' || isDate(since))
    && typeof names === 'object' && Object.values(names).every(isName)
    && typeof choices === 'object' && Object.values(choices).every(isId)
    && typeof gifts === 'object' && gifts !== null && Object.values(gifts).every(isGift)
    && Array.isArray(files) && files.every((file) => Array.isArray(file?.accounts) && file.accounts.every(isAccount)
      && Array.isArray(file.txs) && file.txs.every(isTx))
    && (files.length === 0 || (typeof at === 'string' && !Number.isNaN(Date.parse(at))));
  if (!ok) return null;
  const added = files.reduce((sum, file) => sum + addFile(bank, file, at), 0);
  for (const cat of cats) {
    const saved = bank.cats.find((each) => each.id === cat.id);
    if (saved) Object.assign(saved, cat);
    else bank.cats.push({ ...cat });
  }
  Object.assign(bank.rules, rules);
  Object.assign(bank.fixed, fixed);
  if (since) bank.since = since;
  for (const account of bank.accounts) if (names[account.id]) account.name = names[account.id];
  for (const tx of bank.txs) {
    if (choices[tx.id]) tx.cat = choices[tx.id];
    if (gifts[tx.id] && tx.cents < 0) tx.gift = { shop: gifts[tx.id].shop, value: gifts[tx.id].value };
  }
  return added;
}
