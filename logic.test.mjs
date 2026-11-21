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

test('needsInstall only insists on an iPhone outside the Home Screen', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1';
  assert.ok(logic.needsInstall(iphone, false));
  assert.ok(!logic.needsInstall(iphone, true));
  assert.ok(!logic.needsInstall('Mozilla/5.0 (Windows NT 10.0) Chrome/130', false));
});

test('parseState round-trips good data and drops unknown fields', () => {
  const parsed = logic.parseState(JSON.stringify({ app: 'ah-saldo', cards: [{ ...card(), extra: '<b>' }] }));
  assert.deepEqual(parsed, { cards: [card()], needsBackup: false });
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
