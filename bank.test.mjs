// Run with: node --test
// Every name, number and amount below is made up; only the file formats are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as bank from './bank.js';

const NOW = '2026-11-22T16:00:00.000Z';

// ---------- a made-up Rabo account export ----------
const RABO_HEAD = '"IBAN/BBAN","Munt","BIC","Volgnr","Datum","Rentedatum","Bedrag","Saldo na trn","Tegenrekening IBAN/BBAN","Naam tegenpartij","Code","Omschrijving-1","Omschrijving-2","Omschrijving-3"';
const raboLine = (seq, date, amount, after, iban, name, code = 'bc', text = '') =>
  `"NL00TEST0123456789","EUR","TESTNL2U","${String(seq).padStart(18, '0')}","${date}","${date}","${amount}","${after}","${iban}","${name}","${code}","${text}","",""`;
const RABO = [
  RABO_HEAD,
  raboLine(11, '2026-06-25', '+3000,00', '+3100,00', 'NL00TEST0000000001', 'Voorbeeld B.V.', 'sb', 'SALARIS JUNI'),
  raboLine(12, '2026-06-26', '-12,50', '+3087,50', '', 'Bakker "De Korst", Dorp', 'bc', 'Dorp, 21:51'),
  raboLine(13, '2026-06-26', '-12,50', '+3075,00', '', 'Bakker "De Korst", Dorp', 'bc', 'Dorp, 21:52'),
  raboLine(14, '2026-06-27', '-45,10', '+3029,90', '', 'Albert Heijn 1234', 'bc'),
  raboLine(15, '2026-06-28', '-100,00', '+2929,90', 'NL00TEST0999999999', 'J. Jansen', 'tb'),
  raboLine(16, '2026-06-29', '-200,00', '+2729,90', '', 'Rabobank Nederland', 'cc'),
  raboLine(17, '2026-06-30', '-47,00', '+2682,90', 'NL00TEST0000000002', 'Wissel Nederland B.V.', 'id'),
  raboLine(18, '2026-07-01', '+20,00', '+2702,90', 'NL00TEST0000000003', 'AAB INZ TIKKIE', 'cb', 'Etentje'),
].map((line) => line.replaceAll('De Korst"', 'De Korst""').replaceAll('"De Korst', '""De Korst')).join('\r\n');

const CARD = [
  '"Tegenrekening IBAN","Munt","Creditcard Nummer","Productnaam","Creditcard Regel1","Creditcard Regel2","Transactiereferentie","Datum","Bedrag","Omschrijving","Oorspr bedrag","Oorspr munt","Koers"',
  '"NL00TEST0123456789","EUR","9999","Rabo TestCard","J. JANSEN","","P1","2026-07-02","-2.058,80","HOTEL VOORBEELD      PARIS   FR","","",""',
  '"NL00TEST0123456789","EUR","9999","Rabo TestCard","J. JANSEN","","P2","2026-07-03","-8,69","SOFTWARE INC         NEW YORK US","10,00","USD","1,15"',
  '"NL00TEST0123456789","EUR","9999","Rabo TestCard","J. JANSEN","","P3","2026-07-04","+200,00","Verrekening vorig overzicht","","",""',
].join('\n');

// ---------- a made-up Openbank statement, as the pieces of text a PDF reader hands over ----------
// Each line is { date, concept lines, amount, balance after }, newest first, as on the statement.
function statement(lines, { closing, holder = 'ANNA TEST', rows = 3 } = {}) {
  const items = [
    { page: 1, x: 22.3, y: 105.3, str: 'Open Bank S.A. Statutaire zetel: ergens' }, // small print, at the height of a line
    { page: 1, x: 60.3, y: 668.6, str: 'Rekeningnummer:' }, { page: 1, x: 136.7, y: 668.9, str: 'ES0000730100550000000001' },
    { page: 1, x: 60.2, y: 634.5, str: 'Houder:' }, { page: 1, x: 119.9, y: 634.7, str: holder },
    { page: 1, x: 60.2, y: 617.5, str: 'Saldo:' }, { page: 1, x: 119.9, y: 617.7, str: `${closing} EUR` },
  ];
  lines.forEach(([date, concept, amount, after], index) => {
    const page = 1 + Math.floor(index / rows);
    const y = 164.4 - (index % rows) * 29.55; // the last line of a full page lands on the small print's height
    if (index % rows === 0) {
      items.push({ page, x: 119.4, y: 190, str: 'Valutadatum' }, { page, x: 277.2, y: 190, str: 'Concept' }, { page, x: 438.6, y: 190, str: 'Bedrag' });
    }
    items.push({ page, x: 61.4, y, str: date }, { page, x: 122.4, y, str: date }, { page, x: 463.8, y, str: amount }, { page, x: 553.1, y, str: after });
    concept.forEach((part, at) => items.push({ page, x: 182.2, y: y + (concept.length - 1) * 4.15 - at * 8.3, str: part }));
  });
  return items;
}
const OPENBANK = [
  ['2026-07-03', ['ONMIDDELLIJKE OVERBOEKING TEN GUNSTE VAN j', 'jansen'], '-350.0', '14.88'],
  ['2026-07-02', ['OVERBOEKING TEN GUNSTE VAN TEST ANNA'], '-38.7', '364.88'],
  ['2026-07-02', ['OVERBOEKING VAN Werkgever B. V., REFERENTIE', '0726-EXTRA'], '38.7', '403.58'],
  ['2026-07-02', ['OVERBOEKING TEN GUNSTE VAN TEST ANNA'], '-38.7', '364.88'],
  ['2026-07-02', ['OVERBOEKING VAN Werkgever B. V., REFERENTIE', '0726-EXTRA'], '38.7', '403.58'],
  ['2026-07-01', ['OVERBOEKING VAN Werkgever B. V., REFERENTIE', '0726-SALARY-Werkgever', 'B 123'], '364.88', '364.88'],
];

const loaded = () => {
  const data = bank.emptyBank();
  bank.addFile(data, bank.readCsv(RABO), NOW);
  return data;
};
const tx = (over) => ({ id: `t.${Math.random()}`.replace('0.', ''), acc: 'A', date: '2026-07-10', cents: -1000, name: 'Winkel', text: '', ...over });
const withTxs = (...txs) => ({ ...bank.emptyBank(), txs });

test('bankCents reads bank amounts as cents', () => {
  assert.equal(bank.bankCents('-2.058,80'), -205880);
  assert.equal(bank.bankCents('+1897,72'), 189772);
  assert.equal(bank.bankCents('-3,4'), -340);
  assert.equal(bank.bankCents('12'), 1200);
  for (const bad of ['', 'abc', '1,234', '--5', '1,2,3']) assert.equal(bank.bankCents(bad), null, bad);
});

test('parseCsv handles quotes, commas inside fields and both line endings', () => {
  assert.deepEqual(bank.parseCsv('a,b\r\n"x, y","say ""hi"""\n\n"two\nlines",z'), [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']]);
});

test('decodeText reads UTF-8 and falls back to Windows-1252', () => {
  assert.equal(bank.decodeText(new TextEncoder().encode('initiërende')), 'initiërende');
  assert.equal(bank.decodeText(new Uint8Array([0x69, 0xeb, 0x72])), 'iër');
});

test('a Rabo account file gives transactions keyed by sequence number', () => {
  const file = bank.readCsv(RABO);
  assert.deepEqual(file.accounts, [{ id: 'NL00TEST0123456789', name: 'Rabo 6789', bank: 'Rabo', balance: 270290 }]);
  assert.equal(file.txs.length, 8);
  assert.deepEqual(file.txs[1], { id: 'NL00TEST0123456789.12', acc: 'NL00TEST0123456789', date: '2026-06-26', cents: -1250, name: 'Bakker "De Korst", Dorp', text: 'Dorp, 21:51' });
  assert.notEqual(file.txs[1].id, file.txs[2].id); // same day, amount and name, still two payments
  assert.equal(file.txs[4].iban, 'NL00TEST0999999999');
  assert.equal(file.txs[5].own, true); // paying off the credit card
});

test('a Rabo file whose balances do not add up is refused', () => {
  assert.throws(() => bank.readCsv(RABO.replace('+3087,50', '+3087,49')), /broken/);
  assert.throws(() => bank.readCsv(RABO.replace('-45,10', 'veel')), /broken/);
  assert.throws(() => bank.readCsv('naam,bedrag\nx,1'), /unknown/);
});

test('a credit card file gives transactions keyed by reference', () => {
  const file = bank.readCsv(CARD);
  assert.deepEqual(file.accounts, [{ id: 'CC9999', name: 'Rabo TestCard', bank: 'Rabo', card: true }]);
  assert.deepEqual(file.txs.map((each) => [each.id, each.cents, each.name]), [
    ['CC9999.P1', -205880, 'HOTEL VOORBEELD PARIS FR'], ['CC9999.P2', -869, 'SOFTWARE INC NEW YORK US'], ['CC9999.P3', 20000, 'Verrekening vorig overzicht'],
  ]);
  assert.equal(file.txs[1].text, '10,00 USD');
  assert.equal(file.txs[2].own, true);
  const data = bank.emptyBank();
  bank.addFile(data, file, NOW);
  assert.equal(bank.balanceOn(data, data.accounts[0]), -205880 - 869 + 20000); // no balance in the file: the sum of its lines
});

test('an Openbank statement is read as a table, descriptions over several lines included', () => {
  const file = bank.readOpenbank(statement(OPENBANK, { closing: '14.88' }));
  assert.deepEqual(file.accounts, [{ id: 'ES0000730100550000000001', name: 'Openbank 0001', bank: 'Openbank', balance: 1488, holder: 'ANNA TEST' }]);
  assert.equal(file.txs.length, 6);
  assert.deepEqual(file.txs.map((each) => each.date), ['2026-07-01', '2026-07-02', '2026-07-02', '2026-07-02', '2026-07-02', '2026-07-03']); // oldest first
  const { id, ...salary } = file.txs[0];
  assert.deepEqual(salary, { acc: 'ES0000730100550000000001', date: '2026-07-01', cents: 36488, name: 'Werkgever B. V.', text: '0726-SALARY-Werkgever B 123' });
  assert.equal(file.txs[5].name, 'j jansen');
  assert.equal(file.txs[2].own, true); // to the holder's own other account, whichever way round the name is written
  assert.equal(file.txs[0].own, undefined);
  assert.equal(new Set(file.txs.map((each) => each.id)).size, 6); // the two equal pairs on 2 July keep apart
});

test('an Openbank statement that does not add up is refused', () => {
  assert.throws(() => bank.readOpenbank(statement(OPENBANK, { closing: '15.88' })), /broken/);
  const gone = statement(OPENBANK, { closing: '14.88' }).filter((item) => item.str !== '-38.7' || item.y < 100);
  assert.throws(() => bank.readOpenbank(gone), /broken/);
  assert.throws(() => bank.readOpenbank([{ page: 1, x: 0, y: 0, str: 'Een andere pdf' }]), /unknown/);
});

test('reading a file again, or one that overlaps, adds nothing twice', () => {
  const data = bank.emptyBank();
  assert.equal(bank.addFile(data, bank.readCsv(RABO), NOW), 8);
  assert.equal(bank.addFile(data, bank.readCsv(RABO), NOW), 0);
  const older = statement(OPENBANK.slice(2), { closing: '403.58' }); // downloaded before the last two lines existed
  assert.equal(bank.addFile(data, bank.readOpenbank(older), '2026-07-02T12:00:00.000Z'), 4);
  assert.equal(bank.addFile(data, bank.readOpenbank(statement(OPENBANK, { closing: '14.88' })), NOW), 2);
  assert.equal(bank.addFile(data, bank.readOpenbank(older), NOW), 0);
  const openbank = data.accounts.find((account) => account.bank === 'Openbank');
  assert.deepEqual([openbank.through, openbank.balance, openbank.uploaded], ['2026-07-03', 1488, NOW]); // the older file did not bring its balance back
  assert.equal(data.txs.length, 14);
});

// ---------- made-up lines as the Rabo link (Enable Banking) sends them ----------
const linked = (seq, date, amount, indicator, party, { iban, code = 'bc', text, status = 'BOOK' } = {}) => ({
  entry_reference: String(seq), status, booking_date: date, value_date: date, credit_debit_indicator: indicator,
  transaction_amount: { currency: 'EUR', amount }, bank_transaction_code: { code: '0', sub_code: code },
  [indicator === 'DBIT' ? 'creditor' : 'debtor']: { name: party },
  [indicator === 'DBIT' ? 'creditor_account' : 'debtor_account']: iban ? { iban } : null,
  remittance_information: text ? [text] : [],
});
const LINKED = [{
  iban: 'NL00TEST0123456789',
  balances: [{ balance_type: 'XPCD', balance_amount: { amount: '1.00' } }, { balance_type: 'ITBD', balance_amount: { amount: '2662.90' } }],
  txs: [ // as the link sends them: not oldest first
    linked(19, '2026-07-02', '40.00', 'DBIT', 'Rabobank Nederland', { code: 'cc' }),
    linked(17, '2026-06-30', '47.00', 'DBIT', 'Wissel Nederland B.V.', { iban: 'NL00TEST0000000002', code: 'id' }),
    linked(18, '2026-07-01', '20.00', 'CRDT', 'AAB INZ TIKKIE', { iban: 'NL00TEST0000000003', code: 'cb', text: 'Etentje' }),
    linked(20, '2026-07-02', '5.00', 'DBIT', 'Nog niet geboekt', { status: 'PDNG' }),
  ],
}];

test('the Rabo link gives the lines of the CSV the same ids and texts, so only new ones are added', () => {
  const data = loaded();
  const csv = data.txs.find((each) => each.id === 'NL00TEST0123456789.18');
  const file = bank.readLinked(LINKED);
  assert.deepEqual(file.txs.find((each) => each.id === csv.id), csv);
  assert.deepEqual(file.txs.map((each) => each.id.split('.')[1]), ['17', '18', '19']);
  assert.equal(bank.addFile(data, file, NOW), 1); // 17 and 18 were in the CSV, 20 is not booked yet
  assert.deepEqual(data.txs.at(-1), { id: 'NL00TEST0123456789.19', acc: 'NL00TEST0123456789', date: '2026-07-02', cents: -4000, name: 'Rabobank Nederland', text: '', own: true });
  assert.deepEqual([data.accounts[0].balance, data.accounts[0].through, data.accounts[0].name], [266290, '2026-07-02', 'Rabo 6789']);
  assert.equal(bank.hasGap(data, data.accounts[0]), false);
  assert.deepEqual(bank.readLinked([{ ...LINKED[0], txs: [] }]).txs, []); // nothing new since the last time
  assert.throws(() => bank.readLinked([{ ...LINKED[0], txs: [{ ...LINKED[0].txs[0], entry_reference: 'x1' }] }]), /broken/);
  assert.throws(() => bank.readLinked([{ ...LINKED[0], txs: [{ ...LINKED[0].txs[0], transaction_amount: { amount: '4,00' } }] }]), /broken/);
});

// The made-up Openbank statement above as its bank link sends it: a day's lines numbered from the newest (1) back,
// no balance per line, only the balance now.
function openbankLink(rows, balance) {
  const counters = new Map();
  const txs = rows.map(([date, concept, amount]) => { // newest first, as on the statement
    counters.set(date, (counters.get(date) ?? 0) + 1);
    return {
      entry_reference: `${date}.${counters.get(date)}`, status: 'BOOK', booking_date: date, value_date: date,
      credit_debit_indicator: amount.startsWith('-') ? 'DBIT' : 'CRDT', transaction_amount: { currency: 'EUR', amount: amount.replace('-', '') },
      remittance_information: [concept.join(' ')],
    };
  });
  return [{ iban: 'ES0000730100550000000001', bank: 'Openbank', holder: 'Anna Test', txs, balances: [{ balance_type: 'CLBD', balance_amount: { amount: balance } }] }];
}

test('the Openbank link gives the lines of the statement the same ids, by working back from the balance', () => {
  const pdf = bank.readOpenbank(statement(OPENBANK, { closing: '14.88' }));
  assert.deepEqual(bank.readLinked(openbankLink(OPENBANK, '14.88')).txs, pdf.txs); // own transfers included
  const data = bank.emptyBank();
  bank.addFile(data, pdf, NOW);
  const newer = [['2026-07-04', ['OVERBOEKING TEN GUNSTE VAN Bakker'], '-4.88', '10.00'], ...OPENBANK];
  assert.deepEqual(bank.addLinked(data, bank.readLinked(openbankLink(newer, '10.00')), NOW), { added: 1, skipped: [] });
  assert.equal(data.accounts[0].balance, 1000);
  // a line missing in between moves every balance before it, so the ids no longer match: wait for the next fetch
  const holed = openbankLink(newer.filter((row, index) => index !== 2), '10.00');
  assert.deepEqual(bank.addLinked(data, bank.readLinked(holed), NOW), { added: 0, skipped: ['ES0000730100550000000001'] });
  assert.equal(data.txs.length, 7);
});

test('an Openbank line that has no number yet is read at once, and read again until it has one', () => {
  const pdf = bank.readOpenbank(statement(OPENBANK, { closing: '14.88' }));
  const slager = ['2026-07-04', ['OVERBOEKING TEN GUNSTE VAN Slager'], '-3.00', '7.00'];
  const bakker = ['2026-07-04', ['OVERBOEKING TEN GUNSTE VAN Bakker'], '-4.88', '10.00'];
  const link = (newest, unnumbered) => {
    const list = openbankLink([...newest, ...OPENBANK], '7.00');
    for (const line of list[0].txs.slice(0, unnumbered)) line.entry_reference = null; // as a line of a day that is not over comes
    return bank.readLinked(list);
  };
  const start = () => {
    const data = bank.emptyBank();
    bank.addFile(data, pdf, NOW);
    return data;
  };
  const today = link([slager, bakker], 2);
  // in the order sent, newest first, they get the ids they have once numbered; the lines before them keep the statement's
  assert.deepEqual(today.txs.map(({ early, ...tx }) => tx), link([slager, bakker], 0).txs);
  assert.deepEqual(today.txs.filter((tx) => tx.early).map((tx) => tx.name), ['Bakker', 'Slager']);
  assert.deepEqual(today.txs.slice(0, -2), pdf.txs);
  const add = (to) => bank.addLinked(to, link([slager, bakker], 2), NOW); // a file's lines become the saved ones: a fresh one each time
  let data = start();
  assert.deepEqual(add(data), { added: 2, skipped: [] });
  assert.deepEqual([data.accounts[0].balance, data.accounts[0].through], [700, '2026-07-04']);
  assert.deepEqual(bank.parseBank(JSON.parse(JSON.stringify(data))).txs, data.txs); // saved and read back, early stays
  // the day after, numbered in that order: nothing new, early no longer, what the user gave the line is kept
  data.txs.at(-1).cat = 'boodschappen';
  assert.deepEqual(bank.addLinked(data, link([slager, bakker], 0), NOW), { added: 0, skipped: [] });
  assert.deepEqual([data.txs.some((tx) => tx.early), data.txs.at(-1).cat, data.txs.length], [false, 'boodschappen', 8]);
  // numbered the other way round: the lines they became take their place, nothing is there twice
  data = start();
  add(data);
  assert.deepEqual(bank.addLinked(data, link([bakker, slager], 0), NOW), { added: 2, skipped: [] });
  assert.deepEqual([data.txs.some((tx) => tx.early), data.txs.length, bank.balanceOn(data, data.accounts[0])], [false, 8, 700]);
  // a fetch that does not reach back to the day of an early line leaves it alone, and so does one without that account
  data = start();
  add(data);
  const later ={ accounts: today.accounts, txs: [{ ...today.txs[0], id: 'ES0000730100550000000001.later', date: '2026-07-09' }] };
  bank.addLinked(data, later, NOW);
  bank.addLinked(data, { accounts: [], txs: [] }, NOW);
  assert.equal(data.txs.filter((tx) => tx.early).length, 2);
});

test('a balance on an earlier day follows from what was booked after it', () => {
  const data = loaded();
  const [account] = data.accounts;
  assert.equal(bank.balanceOn(data, account), 270290);
  assert.equal(bank.balanceOn(data, account, '2026-06-30'), 268290);
  assert.equal(bank.balanceOn(data, account, '2026-06-25'), 310000);
  const cards = [{ entries: [{ at: '2026-06-01T10:00:00.000Z', delta: 5000 }, { at: '2026-07-05T10:00:00.000Z', delta: -1200 }] }];
  assert.deepEqual([bank.cardsOn(cards, '2026-06-30'), bank.cardsOn(cards, '2026-07-31')], [5000, 3800]);
});

test('hasGap notices missing lines of a Rabo account', () => {
  const data = loaded();
  assert.equal(bank.hasGap(data, data.accounts[0]), false);
  data.txs.splice(3, 1);
  assert.equal(bank.hasGap(data, data.accounts[0]), true);
});

test('ruleKey drops branch numbers, marks and case', () => {
  assert.equal(bank.ruleKey('Albert Heijn 1579'), 'albert heijn');
  assert.equal(bank.ruleKey('BCK*McDonalds Dorp'), 'bck mcdonalds dorp');
  assert.equal(bank.ruleKey('Café Zoë'), 'café zoë');
});

test('a transaction is sorted by its own choice, then the rule, then what the app can tell', () => {
  const data = loaded();
  data.accounts.push({ id: 'NL00TEST0999999999', name: 'Spaar', bank: 'Rabo', through: '', uploaded: NOW });
  const catOf = bank.sorter(data);
  const cats = () => data.txs.map(bank.sorter(data));
  assert.deepEqual(cats(), ['', '', '', 'boodschappen', 'overboeking', 'overboeking', 'cadeaukaarten', '']);
  data.rules[bank.ruleKey('Bakker "De Korst", Dorp')] = 'fun';
  data.rules['albert heijn'] = 'overig'; // a rule of the user's beats the built-in one
  data.txs[2].cat = 'anderen';
  assert.deepEqual(cats().slice(1, 4), ['fun', 'anderen', 'overig']);
  data.txs[2].cat = 'weg'; // a category that no longer exists
  assert.equal(bank.sorter(data)(data.txs[2]), '');
  assert.equal(catOf(tx({ name: 'Plus via Tikkie' })), '');
  assert.equal(catOf(tx({ name: 'BCK*Jumbo Dorp' })), 'boodschappen');
  assert.equal(catOf(tx({ name: 'Plus Abonnement Service' })), 'boodschappen'); // the chain's name leads: a rule of the user's can correct it
  assert.equal(catOf(tx({ name: 'Spotify AB' })), 'abonnementen');
  assert.equal(catOf(tx({ name: 'help.hbomax.com Stockholm SWE' })), 'abonnementen');
  assert.equal(catOf(tx({ name: 'KPN B.V.' })), 'abonnementen');
  assert.equal(catOf(tx({ name: 'Disney Plus' })), 'abonnementen');
  assert.equal(catOf(tx({ name: 'Canal Plus' })), '');
  assert.equal(catOf(tx({ name: "McDonald's Dorp" })), 'uiteten');
  assert.equal(catOf(tx({ name: 'BCK*Mc Donalds Dorp' })), 'uiteten');
  assert.equal(catOf(tx({ name: 'NS Reizigers B.V.' })), 'auto');
  assert.equal(catOf(tx({ name: 'NLOVAB1CDEFGH2I3J4' })), 'auto'); // a bus trip paid with the bank card
  assert.equal(catOf(tx({ name: 'NS Vastgoed' })), '');
});

test('figures: income, spending, money back, neutral money and what is not sorted yet', () => {
  const data = loaded();
  data.rules['voorbeeld b v'] = 'salaris';
  data.rules[bank.ruleKey('Bakker "De Korst", Dorp')] = 'fun';
  data.rules['aab inz tikkie'] = 'fun'; // money back lowers what was spent on fun
  const all = bank.figures(data, [], '2026-06-01', '2026-08-01');
  assert.equal(all.income, 300000);
  assert.equal(all.spending, 2500 + 4510 + 10000 + 4700 - 2000); // J. Jansen is not sorted yet and counts as spending
  assert.equal(all.open, 1);
  assert.deepEqual([...all.byCat].sort(), [['', 10000], ['boodschappen', 4510], ['cadeaukaarten', 4700], ['fun', 500], ['salaris', 300000]]);
  assert.deepEqual([...all.moved], [['overboeking', -20000]]); // the credit card's bill: not spending, but it left this account
  assert.equal(all.income - all.spending + all.moved.get('overboeking'), data.txs.reduce((sum, each) => sum + each.cents, 0)); // so the three add up to what the account lost or gained
  const june = bank.figures(data, [], '2026-06-01', '2026-07-01');
  assert.equal(june.byCat.get('fun'), 2500);
  data.since = '2026-06-27';
  assert.equal(bank.figures(data, [], '2026-06-01', '2026-07-01').income, 0);
});

test('figures: a gift card payment counts its card part, and a share for someone else comes out of that first', () => {
  const purchase = (cards, shares) => ({ at: '2026-07-10T12:00:00.000Z', total: 5000, cards, shares });
  const data = bank.emptyBank();
  const run = (...purchases) => {
    const { spending, byCat } = bank.figures(data, purchases, '2026-07-01', '2026-08-01');
    return [spending, byCat.get('boodschappen') ?? 0, byCat.get('anderen') ?? 0];
  };
  assert.deepEqual(run(purchase(3000, [{ who: 'Wij', cents: 5000 }])), [3000, 3000, 0]);
  assert.deepEqual(run(purchase(3000, [{ who: 'Wij', cents: 4000 }, { who: 'Oma', cents: 1000 }])), [3000, 2000, 1000]);
  assert.deepEqual(run(purchase(3000, [{ who: 'Oma', cents: 5000 }])), [3000, 0, 3000]); // no more than the cards paid
  assert.deepEqual(run(purchase(0, [{ who: 'Wij', cents: 5000 }])), [0, 0, 0]); // all pin: the bank statement has it
  assert.deepEqual(run({ ...purchase(3000, [{ who: 'Wij', cents: 5000 }]), at: '2026-08-01T12:00:00.000Z' }), [0, 0, 0]);
});

test('gift cards: a card for another shop is spending, an AH card is balance, and both say what they saved', () => {
  const wissel = (id, date, cents, gift) => tx({ id, date, cents, name: 'Wissel Nederland B.V.', ...(gift && { gift }) });
  const data = withTxs(
    wissel('a', '2026-07-02', -4700, { shop: 'Boekenbon', value: 5000 }),
    wissel('b', '2026-07-03', -4433, { shop: 'Albert Heijn', value: 4500 }),
    wissel('c', '2026-07-04', -9400, { shop: 'Boekenbon', value: 10000 }),
    wissel('d', '2026-07-05', -9800), // paid and paid back: it bought nothing
    tx({ id: 'e', date: '2026-07-06', cents: 9800, name: 'Wissel Nederland BV' }),
    wissel('f', '2026-07-07', -9800), // the same amount again, and this one stayed
    wissel('g', '2026-06-20', -3940, { shop: 'Albert Heijn', value: 4000 }),
  );
  data.txs.at(-1).cat = 'boodschappen'; // an AH card from before the app paid at the till: groceries on the day it was bought
  const sum = bank.figures(data, [], '2026-06-01', '2026-08-01');
  assert.equal(sum.byCat.get('cadeaukaarten'), 4700 + 9400 + 9800 - 9800 + 9800); // the AH card of 44,33 is not in it
  assert.deepEqual([...sum.moved], [['cadeaukaarten', -4433]]); // it moved onto the card
  assert.equal(sum.byCat.get('boodschappen'), 3940);
  assert.equal(sum.spending, 4700 + 9400 + 9800 + 3940);
  assert.deepEqual(bank.giftsBought(data, '2026-07-01', '2026-08-01'), [
    { shop: 'Boekenbon', value: 15000, paid: 14100, count: 2 }, { shop: 'Albert Heijn', value: 4500, paid: 4433, count: 1 }]);
  assert.equal(bank.giftsBought(data, '', '9999')[1].value, 8500); // a card counts whatever category its payment is in
  data.since = '2026-07-03';
  assert.deepEqual(bank.giftsBought(data, '', '9999').map((shop) => shop.value), [10000, 4500]);
  assert.deepEqual(bank.giftsToFill(data).map((each) => each.id), ['f']);
  data.txs.find((each) => each.id === 'f').cat = 'winkelen'; // sorted somewhere else: not a gift card after all
  assert.deepEqual(bank.giftsToFill(data), []);
  assert.deepEqual(bank.parseBank(JSON.parse(JSON.stringify(data))).txs[0].gift, { shop: 'Boekenbon', value: 5000 });
  const bad = (gift, cents = -4700) => assert.throws(() => bank.parseBank({ ...bank.emptyBank(), txs: [tx({ cents, gift })] }));
  bad({ shop: '', value: 5000 });
  bad({ shop: 'Boekenbon', value: 0 });
  bad({ shop: 'Boekenbon', value: 5000 }, 4700); // money that came in bought no card
});

test('gift cards: the app guesses the shop and the value from what was paid before', () => {
  const wissel = (date, cents, shop, value) => tx({ date, cents, name: 'Wissel Nederland B.V.', gift: { shop, value } });
  const data = withTxs(
    wissel('2026-07-01', -3940, 'Albert Heijn', 4000), // 1,5% off
    wissel('2026-07-02', -4750, 'Boekenbon', 5000), // 5% off then
    wissel('2026-07-09', -4700, 'Boekenbon', 5000), // 6% off now
    wissel('2026-07-10', -25, 'Speelgoedbon', 2500), // paid with points: its price says nothing
    wissel('2026-07-12', -875, 'Boekenbon', 1500), // partly paid some other way: the 6% stays the shop's discount
  );
  assert.deepEqual(bank.giftGuesses(data, 4433)[0], { shop: 'Albert Heijn', value: 4500 });
  assert.deepEqual(bank.giftGuesses(data, 14100)[0], { shop: 'Boekenbon', value: 15000 });
  assert.deepEqual(bank.giftGuesses(data, 950).find((guess) => guess.shop === 'Boekenbon'), { shop: 'Boekenbon', value: 1000 }); // 5% again: still a round value
  assert.deepEqual(bank.giftGuesses(data, 6888).find((guess) => guess.shop === 'Boekenbon'), { shop: 'Boekenbon', value: 7330 }); // no round value near: to the nearest five cents
  assert.deepEqual(bank.giftGuesses(data, 1234).map((guess) => guess.shop), ['Boekenbon', 'Speelgoedbon', 'Albert Heijn']); // no shop fits: the one bought last first
  assert.deepEqual(bank.giftGuesses(bank.emptyBank(), 4433), []);
});

test("a shop's balance: cards bought for it are balance, and what is paid from it is the spending", () => {
  const wissel = (id, date, cents, shop, value) => tx({ id, date, cents, name: 'Wissel Nederland B.V.', gift: { shop, value } });
  const data = withTxs(
    wissel('w1', '2026-07-14', -1900, 'Speelwinkel', 2000),
    wissel('w2', '2026-09-10', -3800, 'Speelwinkel', 4000),
    wissel('w3', '2026-09-11', -4700, 'Boekenbon', 5000),
  );
  const spent = () => bank.figures(data, [], '2026-06-01', '2026-12-01');
  assert.equal(spent().spending, 1900 + 3800 + 4700); // no balance is kept: every card is spent on the day it is bought
  // the shop said 30,00 was left at the end of 1 September; 10,00 goes every month, on the 31st
  const account = bank.addBalance(data, { shop: 'Speelwinkel', balance: 3000, through: '2026-09-01', monthly: [{ name: 'Spelpas', cents: -1000, day: 31, next: '2026-06' }] }, NOW);
  assert.equal(bank.addBalance(data, { shop: 'Speelwinkel', balance: 1, through: '2026-09-01' }, NOW), undefined); // it is kept already
  assert.equal(bank.addBalance(data, { shop: 'Albert Heijn', balance: 1, through: '2026-09-01' }, NOW), undefined); // AH has its cards
  assert.deepEqual(bank.catchUp(data, '2026-09-30').map((each) => each.date), ['2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']); // June and September end on the 30th
  assert.deepEqual(bank.catchUp(data, '2026-09-30'), []); // each month once
  assert.equal(account.monthly[0].next, '2026-10');
  assert.equal(bank.balanceOn(data, account, '2026-09-01'), 3000);
  assert.equal(bank.balanceOn(data, account, '2026-09-10'), 7000); // the card of 40,00 came after that day
  assert.equal(bank.balanceOn(data, account), 6000); // and the payment of 30 September
  assert.equal(bank.balanceOn(data, account, '2026-08-30'), 4000); // before the payment of 31 August
  assert.equal(bank.balanceOn(data, account, '2026-05-31'), 4000); // three payments and one card of 20,00 earlier
  const after = spent();
  assert.equal(after.spending, 4 * 1000 + 4700); // the payments, and the card for the other shop
  assert.deepEqual([...after.moved], [['cadeaukaarten', -1900 - 3800]]);
  // what the balance gained is the cards' worth less what was paid from it
  assert.equal(bank.balanceOn(data, account) - bank.balanceOn(data, account, '2026-05-31'), 2000 + 4000 - 4 * 1000);
  bank.payFrom(data, account, '2026-10-05', -500, 'Los spel');
  assert.equal(bank.balanceOn(data, account), 5500);
  data.txs = data.txs.filter((each) => each.name !== 'Spelpas' || each.date !== '2026-06-30'); // removed by hand
  assert.deepEqual(bank.catchUp(data, '2026-10-30'), []); // it stays away, and October's 31st has not come
  assert.equal(bank.catchUp(data, '2026-10-31').length, 1);
  assert.deepEqual(bank.parseBank(JSON.parse(JSON.stringify(data))).accounts, data.accounts);
  const bad = (change) => assert.throws(() => { const copy = JSON.parse(JSON.stringify(data)); change(copy.accounts[0]); bank.parseBank(copy); });
  bad((copy) => { copy.monthly[0].cents = 1000; }); // money out only
  bad((copy) => { copy.monthly[0].next = '2026-13'; });
  bad((copy) => { delete copy.balance; });
  bad((copy) => { delete copy.shop; }); // monthly payments belong to a shop's balance
});

test('groceries split between people: the household keeps its part, the rest is for others', () => {
  const data = withTxs(
    tx({ id: 'a', name: 'Jumbo Dorp', cents: -5000, shares: [{ who: 'Wij', cents: 3000 }, { who: 'Oma', cents: 1500 }, { who: 'Team', cents: 500 }] }),
    tx({ id: 'b', name: 'Lidl Dorp', cents: -2000 }),
    tx({ id: 'c', name: 'Jumbo Dorp', cents: -1000, shares: [{ who: 'Oma', cents: 1000 }] }), // all of it for someone else
    tx({ id: 'd', name: 'Bakker', cents: -900, cat: 'fun', shares: [{ who: 'Oma', cents: 900 }] }), // not groceries: shares do nothing
  );
  const purchases = [{ at: '2026-07-12T12:00:00.000Z', total: 4000, cards: 2500, shares: [{ who: 'Wij', cents: 3200 }, { who: 'Oma', cents: 800 }] }];
  const sum = bank.figures(data, purchases, '2026-07-01', '2026-08-01');
  assert.equal(sum.spending, 5000 + 2000 + 1000 + 900 + 2500);
  assert.deepEqual([sum.byCat.get('boodschappen'), sum.byCat.get('anderen'), sum.byCat.get('fun')], [3000 + 2000 + 1700, 1500 + 500 + 1000 + 800, 900]);
  assert.deepEqual(bank.forWhom(data, purchases, '2026-07-01', '2026-08-01'), [['Wij', 6700], ['Oma', 3300], ['Team', 500]]);
  assert.deepEqual(bank.forWhom(data, purchases, '2026-08-01', '2026-09-01'), []);
  assert.deepEqual(bank.parseBank(JSON.parse(JSON.stringify(data))).txs[0].shares, data.txs[0].shares);
  const bad = (shares, cents = -5000) => assert.throws(() => bank.parseBank({ ...bank.emptyBank(), txs: [tx({ cents, shares })] }));
  bad([{ who: 'Wij', cents: 3000 }]); // does not add up to the amount
  bad([{ who: '', cents: 5000 }]);
  bad([{ who: 'Wij', cents: 5000 }], 5000); // money that came in is not split
  bad([]);
});

test('inCategory and byParty list what is behind a figure', () => {
  const data = loaded();
  const open = bank.inCategory(data, '', '2026-06-01', '2026-08-01');
  assert.deepEqual(open.map((each) => each.date), ['2026-07-01', '2026-06-28', '2026-06-26', '2026-06-26', '2026-06-25']);
  const sameDay = data.txs.filter((each) => open.includes(each) && each.date === '2026-06-26');
  assert.deepEqual(open.filter((each) => each.date === '2026-06-26'), sameDay.reverse()); // the last added on top
  assert.deepEqual(bank.byParty(open).map(({ name, cents, count }) => [name, cents, count]), [
    ['Voorbeeld B.V.', 300000, 1], ['J. Jansen', -10000, 1], ['Bakker "De Korst", Dorp', -2500, 2], ['AAB INZ TIKKIE', 2000, 1],
  ]);
});

test('fixed costs: suggested after three single monthly payments, then followed per month', () => {
  const monthly = (name, cents, months) => months.map((month) => tx({ name, cents, date: `2026-${month}-05` }));
  const data = withTxs(
    ...monthly('Verzekeraar', -15000, ['07', '08', '09']), tx({ name: 'Verzekeraar', cents: -15600, date: '2026-10-05' }),
    ...monthly('Albert Heijn 1', -2000, ['07', '08', '09']), tx({ name: 'Albert Heijn 2', cents: -2500, date: '2026-09-20' }),
    ...monthly('Sportclub', -3000, ['08', '09']),
    ...monthly('Spaarrekening', -50000, ['07', '08', '09']),
  );
  data.rules.spaarrekening = 'overboeking';
  assert.deepEqual(bank.fixedSuggestions(data, '2026-10'), [{ key: 'verzekeraar', name: 'Verzekeraar', cents: 15000 }]);
  data.fixed.verzekeraar = true;
  data.fixed.sportclub = true;
  assert.deepEqual(bank.fixedSuggestions(data, '2026-10'), []);
  assert.deepEqual(bank.fixedCosts(data, '2026-10'), [
    { key: 'verzekeraar', name: 'Verzekeraar', expected: 15000, paid: 15600, day: 5, on: '2026-10-05' },
    { key: 'sportclub', name: 'Sportclub', expected: 3000, paid: 0, day: 5, on: '' },
  ]);
  data.fixed.sportclub = false; // declined: neither followed nor suggested again
  assert.deepEqual(bank.fixedCosts(data, '2026-10').map((each) => each.key), ['verzekeraar']);
});

test('fixed costs: the usual day is the middle of the last three months, so one late month does not move it', () => {
  const data = withTxs(...['2026-07-01', '2026-08-04', '2026-09-01', '2026-10-02'].map((date) => tx({ name: 'Huur', cents: -90000, date })));
  data.fixed.huur = true;
  assert.equal(bank.fixedCosts(data, '2026-10')[0].day, 1); // 1, 4 and 1: the 4th was late
  assert.equal(bank.fixedCosts(data, '2026-11')[0].day, 2); // 4, 1 and 2
  assert.equal(bank.fixedCosts(data, '2026-09')[0].day, 1); // two months: the earlier of the two
  assert.equal(bank.fixedCosts(data, '2026-07')[0].day, 0); // nothing before it
});

test('dayRate: everyday payments set the pace; a large one, money back, a fixed cost and what is over do not', () => {
  const each = (count, over) => Array.from({ length: count }, () => tx(over));
  const data = withTxs(
    // July to September, 92 days: €920 in everyday payments is €10 a day
    ...each(10, { cents: -9200, date: '2026-08-15' }),
    tx({ name: 'Reisbureau', cents: -276000, date: '2026-07-20' }), tx({ name: 'Reisbureau', cents: 92000, date: '2026-09-02', cat: 'reizen' }),
    // October, seven days old: €210 in everyday payments is €30 a day
    ...each(3, { cents: -7000, date: '2026-10-04' }),
    tx({ name: 'Meubelzaak', cents: -50000, date: '2026-10-02' }), // large: says nothing about tomorrow
    tx({ name: 'Verzekeraar', cents: -1500, date: '2026-09-05' }), tx({ name: 'Verzekeraar', cents: -1500, date: '2026-10-05' }),
    tx({ name: 'Krant', cents: -4600, date: '2026-08-28' }), tx({ name: 'Krant', cents: -4600, date: '2026-09-28' }),
  );
  data.fixed = { verzekeraar: true, krant: false }; // one is followed as a fixed cost, the other was switched off and is over
  assert.deepEqual([...bank.ended(data, '2026-10')], ['krant']);
  assert.deepEqual([...bank.ended(data, '2026-09')], []); // it was still paid that month
  // a week in, this month's pace and the months before weigh the same: €20 a day
  assert.equal(bank.dayRate(data, [], '2026-10-07'), 2000);
  // nothing before this month: only the pace of the everyday payments so far
  assert.equal(bank.dayRate({ ...data, since: '2026-10-01' }, [], '2026-10-07'), 3000);
  // switched off but paid again this month: it is not over, so it is an everyday payment like any other
  assert.equal(Math.round(bank.dayRate({ ...data, txs: [...data.txs, tx({ name: 'Krant', cents: -4600, date: '2026-10-06' })] }, [], '2026-10-07')), 2379);
});

test('salaryBase: the salary of the three months before, of the months there are while the data is younger', () => {
  const data = withTxs(...['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].flatMap((month, index) => [
    tx({ name: 'Werkgever', cents: 300000 + index * 10000, date: `${month}-20`, cat: 'salaris' }),
    tx({ name: 'Bakker', cents: -1000, date: `${month}-05` }),
  ]));
  // November is held against August to October: (€3,200 + €3,300 + €3,400) / 3; June and July are shown, not counted
  const base = bank.salaryBase(data, [], '2026-11');
  assert.deepEqual(base.past.map((each) => each.month), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(base.counted.map((each) => each.month), ['2026-08', '2026-09', '2026-10']);
  assert.equal(base.usual, 330000);
  // a month that is not in the data from its first day does not count
  assert.deepEqual(bank.salaryBase({ ...data, since: '2026-09-15' }, [], '2026-11').counted.map((each) => each.month), ['2026-10']);
  assert.equal(bank.salaryBase({ ...data, since: '2026-09-15' }, [], '2026-11').usual, 340000);
  // the first month of the data has nothing to go by
  assert.equal(bank.salaryBase({ ...data, since: '2026-11-01' }, [], '2026-11').usual, 0);
});

test('planned payments stay open until the bank shows a payment of about that amount', () => {
  const data = withTxs(
    tx({ id: 'trip', name: 'Reisbureau', cents: -205000, date: '2026-11-25' }),
    tx({ name: 'Garage', cents: -30000, date: '2026-11-10' }), // before the tyres were planned: not them
    tx({ name: 'Spaarrekening', cents: -30000, date: '2026-11-24', cat: 'overboeking' }), // money that only moved pays for nothing
  );
  const plan = (id, cents, date, since = '2026-11-20') => ({ id, name: id, cents, date, since });
  data.planned = [plan('vakantie', 200000, '2026-11-28'), plan('banden', 30000, '2026-11-30'), plan('fiets', 60000, '2026-12-05'), plan('oud', 10000, '2026-10-15', '2026-10-01')];
  // the trip is paid (€2,050 is within a tenth of €2,000), last month's plan is over, next month's waits
  assert.deepEqual(bank.plannedOpen(data, '2026-11-26').map((each) => each.id), ['banden', 'fiets']);
  // one line settles one payment
  data.planned.push(plan('vakantie2', 200000, '2026-11-29'));
  assert.deepEqual(bank.plannedOpen(data, '2026-11-26').map((each) => each.id), ['banden', 'fiets', 'vakantie2']);
  // a line of the month after is no payment of this month's plan
  data.txs.push(tx({ name: 'Bandenboer', cents: -30000, date: '2026-12-02' }));
  assert.deepEqual(bank.plannedOpen(data, '2026-11-26').map((each) => each.id), ['banden', 'fiets', 'vakantie2']);
});

test('shiftMonth steps over year ends', () => {
  assert.equal(bank.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(bank.shiftMonth('2026-11', 3), '2027-02');
});

test('parseBank keeps saved data and refuses anything else', () => {
  const data = loaded();
  data.rules['voorbeeld b v'] = 'salaris';
  data.fixed.verzekeraar = true;
  data.cats[0].budget = 40000;
  data.txs[0].cat = 'salaris';
  data.planned.push({ id: 'p1', name: 'Vakantie', cents: 200000, date: '2026-12-05', since: '2026-11-23' });
  assert.deepEqual(bank.parseBank(JSON.parse(JSON.stringify(data))), data);
  assert.deepEqual(bank.parseBank(JSON.parse(JSON.stringify(bank.emptyBank()))), bank.emptyBank());
  assert.deepEqual(bank.parseBank(JSON.parse(JSON.stringify({ ...data, planned: undefined }))).planned, []); // saved before there were plans
  assert.throws(() => bank.parseBank({ ...data, planned: [{ id: 'p2', name: 'Fiets', cents: -5, date: '2026-12-05', since: '2026-11-23' }] }));
  const bad = (change) => {
    const copy = JSON.parse(JSON.stringify(data));
    change(copy);
    assert.throws(() => bank.parseBank(copy));
  };
  bad((copy) => { copy.txs[0].cents = 1.5; });
  bad((copy) => { copy.txs[0].name = 'x\u0000'; });
  bad((copy) => { copy.txs[0].id = '<b>'; });
  bad((copy) => { copy.cats[0].kind = 'weg'; });
  bad((copy) => { copy.cats.push(copy.cats[0]); });
  bad((copy) => { copy.rules.winkel = '<script>'; });
  bad((copy) => { copy.accounts[0].name = ''; });
  bad((copy) => { delete copy.since; });
  assert.throws(() => bank.parseBank(null));
});

test('a starter file adds categories, rules, names and choices, or nothing at all', () => {
  const data = loaded();
  const starter = {
    kind: 'kassa-start', since: '2026-06-01',
    cats: [{ id: 'sport', name: 'Sport', kind: 'out' }, { id: 'fun', name: 'Fun money', kind: 'out', budget: 40000 }],
    rules: { 'voorbeeld b v': 'salaris' }, fixed: { verzekeraar: true },
    names: { NL00TEST0123456789: 'Betaalrekening' }, choices: { 'NL00TEST0123456789.15': 'sport' },
    gifts: { 'NL00TEST0123456789.17': { shop: 'Boekenbon', value: 5000 }, 'NL00TEST0123456789.11': { shop: 'Boekenbon', value: 5000 } },
  };
  assert.equal(bank.addStarter(data, starter), 0); // it brought no transactions
  assert.deepEqual(data.txs.map((each) => each.gift?.value), [undefined, undefined, undefined, undefined, undefined, undefined, 5000, undefined]); // not on the salary
  assert.equal(bank.addStarter(data, { kind: 'kassa-start', gifts: { 'NL00TEST0123456789.17': { shop: 'Boekenbon' } } }), null);
  const withBalance = { kind: 'kassa-start', balances: [{ shop: 'Boekenbon', balance: 1200, through: '2026-07-01', monthly: [{ name: 'Leesclub', cents: -500, day: 5, next: '2026-07' }] }] };
  assert.equal(bank.addStarter(data, withBalance, NOW), 0);
  assert.equal(bank.addStarter(data, { ...withBalance, balances: [{ ...withBalance.balances[0], balance: 1 }] }, NOW), 0); // a balance the app keeps is left alone
  assert.deepEqual(data.accounts.filter((account) => account.shop).map((account) => [account.shop, account.balance, account.monthly.length]), [['Boekenbon', 1200, 1]]);
  assert.equal(bank.addStarter(data, { kind: 'kassa-start', balances: [{ shop: 'Boekenbon', balance: 'veel', through: '2026-07-01' }] }, NOW), null);
  assert.equal(data.cats.length, bank.START_CATS.length + 1);
  const purchase = { kind: 'kassa-start', trades: [{ id: 'koop-1', stock: 'VWCE.DE', name: 'Vanguard FTSE All-World', date: '2026-11-23', qty: 3, cents: 48034 }] };
  assert.equal(bank.addStarter(data, purchase, NOW), 1);
  assert.equal(bank.addStarter(data, purchase, NOW), 0); // twice adds it once
  assert.deepEqual(data.trades, purchase.trades);
  assert.equal(bank.addStarter(data, { kind: 'kassa-start', trades: [{ ...purchase.trades[0], id: 'koop-2', qty: 0 }] }, NOW), null);
  assert.equal(data.cats.find((cat) => cat.id === 'fun').budget, 40000);
  assert.deepEqual([data.since, data.accounts[0].name, data.txs[4].cat, data.rules['voorbeeld b v']], ['2026-06-01', 'Betaalrekening', 'sport', 'salaris']);
  assert.doesNotThrow(() => bank.parseBank(JSON.parse(JSON.stringify(data))));
  const before = JSON.stringify(data);
  const badFile = { kind: 'kassa-start', at: NOW, files: [{ accounts: [], txs: [{ id: '<b>' }] }] };
  for (const wrong of [null, {}, { kind: 'kassa-start', cats: [{ id: 'x' }] }, { kind: 'kassa-start', rules: { a: '<b>' } }, badFile]) {
    assert.equal(bank.addStarter(data, wrong), null);
  }
  assert.equal(JSON.stringify(data), before);
});

test('a starter file can bring the bank files themselves, read already', () => {
  const starter = {
    kind: 'kassa-start', at: '2026-11-20T10:00:00.000Z', files: [bank.readCsv(RABO), bank.readCsv(CARD)],
    names: { NL00TEST0123456789: 'Betaalrekening' }, choices: { 'NL00TEST0123456789.15': 'overig' },
  };
  const data = bank.emptyBank();
  assert.equal(bank.addStarter(data, JSON.parse(JSON.stringify(starter)), NOW), 11);
  const [account] = data.accounts;
  assert.deepEqual([account.name, account.balance, account.through, account.uploaded], ['Betaalrekening', 270290, '2026-07-01', '2026-11-20T10:00:00.000Z']);
  assert.equal(data.txs.find((tx) => tx.id === 'NL00TEST0123456789.15').cat, 'overig'); // sorted, though it arrived in the same file
  assert.equal(bank.addStarter(data, starter, NOW), 0); // twice adds nothing
  assert.equal(bank.addFile(data, bank.readCsv(RABO), NOW), 0); // and neither does the bank file itself afterwards
  assert.doesNotThrow(() => bank.parseBank(JSON.parse(JSON.stringify(data))));
});

test('what was put in comes from the bank lines sorted as Beleggen, the rest from the purchases', () => {
  const own = { ...tx({ name: 'Degiro inleg van spaarrekening', cents: -43000 }), own: true }; // between own accounts, the broker only mentioned
  const data = withTxs(
    tx({ name: 'Flatex Bank AG', cents: -48500, date: '2026-11-23' }), tx({ name: 'flatexDEGIRO Bank AG', cents: -25000, date: '2026-12-02' }),
    tx({ name: 'flatexDEGIRO Bank AG', cents: 10000, date: '2026-12-20' }), // money taken out again
    tx({ name: 'Flatexit Cafe', cents: -900 }), tx({ name: 'Overboeking naar degiro', cents: -5000 }), own,
  );
  assert.deepEqual(bank.deposits(data).map((line) => line.cents), [10000, -25000, -48500]); // the newest first
  assert.equal(bank.invested(bank.deposits(data)), 63500);
  assert.equal(bank.sorter(data)(own), 'overboeking');
  assert.equal(bank.figures(data, [], '2026-07-01', '2026-08-01').spending, 5900); // what went to the broker is not spent
  data.txs[0].cat = 'overig'; // sorted out of it by hand: it no longer counts, and the screen can say so
  assert.equal(bank.invested(bank.deposits(data)), 15000);
  assert.deepEqual(bank.strayDeposits(data), [data.txs[0]]);
  data.txs[4].cat = 'beleggen'; // and any line can be sorted into it
  assert.equal(bank.invested(bank.deposits(data)), 20000);
  assert.equal(bank.invested([]), 0); // and not -0, which would be shown with a minus sign

  const trade = (over) => ({ id: `t${Math.random()}`.replace('0.', ''), stock: 'VWCE.DE', name: 'Vanguard FTSE All-World', date: '2026-11-23', qty: 3, cents: 48034, ...over });
  data.trades = [trade(), trade({ qty: 2, cents: 33000 }), trade({ qty: -1, cents: -17000 }),
    trade({ stock: 'ASML.AS', name: 'ASML', qty: 1, cents: 60000 }), trade({ stock: 'ASML.AS', name: 'ASML', qty: -1, cents: -65000 })];
  assert.equal(bank.bought(data), 48034 + 33000 - 17000 + 60000 - 65000);
  assert.deepEqual(bank.holdings(data), [{ stock: 'VWCE.DE', name: 'Vanguard FTSE All-World', qty: 4, cents: 64034 }]); // ASML was sold whole
  assert.deepEqual(bank.parseBank(JSON.parse(JSON.stringify(data))).trades, data.trades);
  for (const bad of [{ stock: 'A B' }, { name: '' }, { qty: 0 }, { qty: '3' }, { cents: 1.5 }, { qty: -1, cents: 100 }, { date: '23-11-2026' }]) {
    assert.throws(() => bank.parseBank({ ...data, trades: [trade(bad)] }));
  }
});

test('data saved before there was investing still reads, and gets its category', () => {
  const old = JSON.parse(JSON.stringify(loaded()));
  delete old.trades;
  old.cats = old.cats.filter((cat) => cat.id !== 'beleggen');
  old.stocks = [{ id: 'ASML.AS', name: 'ASML Holding N.V.', qty: 2 }]; // the one day of a list without costs
  const read = bank.parseBank(old);
  assert.deepEqual(read.trades, []);
  assert.equal(read.stocks, undefined);
  assert.deepEqual(read.cats.at(-1), { id: 'beleggen', name: 'Beleggen', kind: 'none' });
  assert.equal(bank.parseBank(JSON.parse(JSON.stringify(read))).cats.length, read.cats.length); // added once
});
