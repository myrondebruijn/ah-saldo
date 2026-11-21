// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as logic from './logic.js';

const entry = (kind, delta, id = kind) => ({ id, at: '2026-11-21T10:00:00.000Z', kind, delta });
const card = (over = {}) => ({
  id: 'card-1', number: '1234567890123456789', code: '123456', expiry: '', entries: [entry('start', 2500)], ...over,
});

test('parseEuro reads amounts as cents and rejects everything else', () => {
  assert.equal(logic.parseEuro('12'), 1200);
  assert.equal(logic.parseEuro('12,5'), 1250);
  assert.equal(logic.parseEuro('12.50'), 1250);
  assert.equal(logic.parseEuro('€ 0,05'), 5);
  assert.equal(logic.parseEuro('0'), 0);
  for (const bad of ['', 'abc', '-5', '1,234', '12,', '1.250,00']) assert.equal(logic.parseEuro(bad), null, bad);
});

test('formatEuro writes Dutch amounts', () => {
  assert.equal(logic.formatEuro(1250).replace(/\s/g, ' '), '€ 12,50');
});

test('balance is the sum of the entries', () => {
  const spent = card({ entries: [entry('start', 2500), entry('pay', -1230), entry('correct', 30)] });
  assert.equal(logic.balance(spent), 1300);
});

test('card number and code validation', () => {
  assert.equal(logic.cleanDigits('1234 5678-9012 3456 789'), '1234567890123456789');
  assert.equal(logic.groupNumber('1234567890123456789'), '1234 5678 9012 3456 789');
  assert.ok(logic.validNumber('1234567890123456789'));
  assert.ok(!logic.validNumber('123456789012345678'));
  assert.ok(!logic.validNumber(1234567890123456789));
  assert.ok(logic.validCode('012345'));
  assert.ok(!logic.validCode('12345'));
});

test('expiryState warns from 30 days ahead and stays valid on the last day', () => {
  assert.equal(logic.expiryState('', '2026-11-21'), 'none');
  assert.equal(logic.expiryState('2026-12-22', '2026-11-21'), 'ok');
  assert.equal(logic.expiryState('2026-12-21', '2026-11-21'), 'soon');
  assert.equal(logic.expiryState('2026-11-21', '2026-11-21'), 'soon');
  assert.equal(logic.expiryState('2026-11-20', '2026-11-21'), 'expired');
});

test('sortCards puts soonest expiry first, undated last, lowest balance first on a tie', () => {
  const cards = [
    card({ id: 'undated' }),
    card({ id: 'late', expiry: '2027-06-01' }),
    card({ id: 'soon-big', expiry: '2027-01-01' }),
    card({ id: 'soon-small', expiry: '2027-01-01', entries: [entry('start', 500)] }),
  ];
  assert.deepEqual(logic.sortCards(cards).map((c) => c.id), ['soon-small', 'soon-big', 'late', 'undated']);
});

test('settle works out what a payment took from each card', () => {
  assert.deepEqual(logic.settle([1270], 500), [500]); // one card, part used
  assert.deepEqual(logic.settle([1270], 1270), [1270]); // one card, exactly emptied
  assert.deepEqual(logic.settle([1270, 5000], 3000), [1270, 1730]); // first emptied, second pays the rest
  assert.deepEqual(logic.settle([1270, 5000], 9000), [1270, 5000]); // more than the cards held: the rest went by pin
  assert.deepEqual(logic.settle([], 2500), []); // no card used at all
  assert.equal(logic.settle([1270, 5000], 1270), 'low'); // the first card alone covered it
  assert.equal(logic.settle([1270], 0), 'low');
  assert.equal(logic.settle([], 0), 'low');
});

test('shareOut gives the main person what the others leave', () => {
  assert.deepEqual(logic.shareOut(4200, 'Wij', []), [{ who: 'Wij', cents: 4200 }]);
  assert.deepEqual(logic.shareOut(4200, 'Wij', [['Oma', 1200]]), [{ who: 'Wij', cents: 3000 }, { who: 'Oma', cents: 1200 }]);
  assert.deepEqual(logic.shareOut(4200, 'Wij', [['Oma', 3000], ['Jan', 1200]]), [{ who: 'Oma', cents: 3000 }, { who: 'Jan', cents: 1200 }]);
  assert.deepEqual(logic.shareOut(4200, 'Oma', [['Oma', 1000]]), [{ who: 'Oma', cents: 4200 }]); // a part for the main person merges
  assert.equal(logic.shareOut(4200, 'Wij', [['Oma', 4201]]), 'over');
});

test('periods start on Monday, the 1st and 1 January, and shift by whole periods', () => {
  const day = new Date(2026, 10, 21, 15, 30); // Saturday 21 November 2026
  const ymd = (date) => logic.isoDate(date);
  assert.equal(ymd(logic.periodStart('week', day)), '2026-11-16');
  assert.equal(ymd(logic.periodStart('month', day)), '2026-11-01');
  assert.equal(ymd(logic.periodStart('year', day)), '2026-01-01');
  assert.equal(ymd(logic.periodStart('week', new Date(2026, 10, 22))), '2026-11-16'); // Sunday still belongs to that week
  assert.equal(ymd(logic.shiftPeriod('week', new Date(2026, 10, 16), -1)), '2026-11-09');
  assert.equal(ymd(logic.shiftPeriod('month', new Date(2026, 0, 1), -1)), '2025-12-01');
  assert.equal(ymd(logic.shiftPeriod('year', new Date(2026, 0, 1), 1)), '2027-01-01');
});

test('isoWeek numbers weeks the Dutch way', () => {
  assert.equal(logic.isoWeek(new Date(2026, 10, 21)), 47);
  assert.equal(logic.isoWeek(new Date(2026, 0, 1)), 1); // a Thursday
  assert.equal(logic.isoWeek(new Date(2027, 0, 1)), 53); // a Friday: still week 53 of 2026
  assert.equal(logic.isoWeek(new Date(2024, 11, 30)), 1); // a Monday that already belongs to 2025
});

test('summarize totals a period per person and per shop', () => {
  const purchase = (id, day, store, total, cards, shares) => ({ id, at: new Date(2026, 10, day, 12).toISOString(), store, total, cards, shares });
  const purchases = [
    purchase('a', 2, 'AH', 3000, 3000, [{ who: 'Wij', cents: 3000 }]),
    purchase('b', 10, 'Jumbo', 4200, 0, [{ who: 'Wij', cents: 3000 }, { who: 'Oma', cents: 1200 }]),
    purchase('c', 20, 'AH', 1000, 400, [{ who: 'Oma', cents: 1000 }]),
    purchase('d', 30, 'Plus', 9900, 0, [{ who: 'Wij', cents: 9900 }]),
  ];
  const first = logic.summarize(purchases, new Date(2026, 10, 1), new Date(2026, 10, 30)); // the 30th itself is outside
  assert.deepEqual(first.purchases.map((each) => each.id), ['c', 'b', 'a']);
  assert.equal(first.total, 8200);
  assert.equal(first.cards, 3400);
  assert.deepEqual(first.byWho, [['Wij', 6000], ['Oma', 2200]]);
  assert.deepEqual(first.byStore, [['Jumbo', 4200], ['AH', 4000]]);
  assert.equal(logic.summarize(purchases, new Date(2025, 0, 1), new Date(2025, 11, 31)).total, 0);
});

test('CODE128 table is well formed', () => {
  assert.equal(logic.CODE128.length, 107);
  assert.equal(new Set(logic.CODE128).size, 107);
  const modules = (pattern) => [...pattern].reduce((sum, width) => sum + Number(width), 0);
  logic.CODE128.forEach((pattern, value) => assert.equal(modules(pattern), value === 106 ? 13 : 11, `value ${value}`));
});

test('code128 packs digit pairs in set C and an odd last digit in set B, with the checksum', () => {
  // start C, 12, 34, checksum (105 + 12*1 + 34*2) % 103 = 82, stop
  assert.equal(logic.code128('1234'), '211232' + '112232' + '131123' + '121241' + '2331112');
  // start C, 12, switch to B, '3' (value 19), checksum (105 + 12 + 100*2 + 19*3) % 103 = 65, stop
  assert.equal(logic.code128('123'), '211232' + '112232' + '114131' + '221132' + '121124' + '2331112');
  // a 19-digit card number: 13 symbols of 11 modules plus the 13-module stop
  const modules = [...logic.code128('1234567890123456789')].reduce((sum, width) => sum + Number(width), 0);
  assert.equal(modules, 156);
});

test('needsInstall only insists on an iPhone outside the Home Screen', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1';
  assert.ok(logic.needsInstall(iphone, false));
  assert.ok(!logic.needsInstall(iphone, true));
  assert.ok(!logic.needsInstall('Mozilla/5.0 (Windows NT 10.0) Chrome/130', false));
});

test('parseState round-trips good data and drops unknown fields', () => {
  const parsed = logic.parseState(JSON.stringify({ app: 'ah-saldo', cards: [{ ...card(), extra: '<b>' }] }));
  assert.deepEqual(parsed, { cards: [card()], purchases: [], needsBackup: false });
});

test('parseState keeps purchases and the card entries that belong to them', () => {
  const bought = { id: 'p1', at: '2026-11-21T10:00:00.000Z', store: "Jumbo & 't Hoekje", total: 4200, cards: 1200, shares: [{ who: 'Wij', cents: 3000 }, { who: 'Oma', cents: 1200 }] };
  const linked = card({ entries: [entry('start', 2500), { ...entry('pay', -1200), purchase: 'p1' }] });
  const parsed = logic.parseState(JSON.stringify({ cards: [linked], purchases: [{ ...bought, extra: 1 }] }));
  assert.deepEqual(parsed, { cards: [linked], purchases: [bought], needsBackup: false });
  const bad = [
    { ...bought, total: 4100 }, // shares no longer add up
    { ...bought, cards: 5000 }, // more from cards than the total
    { ...bought, store: '' },
    { ...bought, store: 'x'.repeat(31) },
    { ...bought, shares: [{ who: ' Wij', cents: 4200 }] }, // untrimmed name
    { ...bought, shares: [] },
    { ...bought, at: 'gisteren' },
  ];
  for (const purchase of bad) assert.throws(() => logic.parseState(JSON.stringify({ cards: [], purchases: [purchase] })), JSON.stringify(purchase));
});

test('parseState rejects anything that is not our shape', () => {
  const bad = [
    'not json',
    '{}',
    JSON.stringify({ cards: [card({ number: '<img src=x onerror=alert(1)>' })] }),
    JSON.stringify({ cards: [card({ code: 123456 })] }),
    JSON.stringify({ cards: [card({ id: '"><script>' })] }),
    JSON.stringify({ cards: [card({ expiry: 'morgen' })] }),
    JSON.stringify({ cards: [card({ entries: [entry('start', 12.5)] })] }),
    JSON.stringify({ cards: [card({ entries: [entry('gift', 100)] })] }),
  ];
  for (const json of bad) assert.throws(() => logic.parseState(json), json);
});
