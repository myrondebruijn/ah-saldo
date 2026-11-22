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
});

test('figures: income, spending, money back, neutral money and what is not sorted yet', () => {
  const data = loaded();
  data.rules['voorbeeld b v'] = 'salaris';
  data.rules[bank.ruleKey('Bakker "De Korst", Dorp')] = 'fun';
  data.rules['aab inz tikkie'] = 'fun'; // money back lowers what was spent on fun
  const all = bank.figures(data, [], '2026-06-01', '2026-08-01');
  assert.equal(all.income, 300000);
  assert.equal(all.spending, 2500 + 4510 + 10000 - 2000); // J. Jansen is not sorted yet and counts as spending
  assert.equal(all.open, 1);
  assert.deepEqual([...all.byCat].sort(), [['', 10000], ['boodschappen', 4510], ['fun', 500], ['salaris', 300000]]);
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
    { key: 'verzekeraar', name: 'Verzekeraar', expected: 15000, paid: 15600 },
    { key: 'sportclub', name: 'Sportclub', expected: 3000, paid: 0 },
  ]);
  data.fixed.sportclub = false; // declined: neither followed nor suggested again
  assert.deepEqual(bank.fixedCosts(data, '2026-10').map((each) => each.key), ['verzekeraar']);
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
  assert.deepEqual(bank.parseBank(JSON.parse(JSON.stringify(data))), data);
  assert.deepEqual(bank.parseBank(JSON.parse(JSON.stringify(bank.emptyBank()))), bank.emptyBank());
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
  };
  assert.equal(bank.addStarter(data, starter), 0); // it brought no transactions
  assert.equal(data.cats.length, bank.START_CATS.length + 1);
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
