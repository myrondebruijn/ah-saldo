// Run with: node --test
// Every card, amount and name below is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as sync from './sync.js';
import * as bank from './bank.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const tx = (id, cents, extra = {}) => ({ id, acc: 'NL00TEST0123456789', date: '2026-11-20', cents, name: 'Winkel', text: '', ...extra });
const BASE = {
  state: { cards: [{ id: 'card-1', number: '1', code: '1', expiry: '', entries: [{ id: 'e1', at: '2026-11-01T10:00:00Z', kind: 'start', delta: 2500 }] }], purchases: [], needsBackup: false },
  bank: { accounts: [], txs: [tx('t1', -500), tx('t2', -700)], cats: [{ id: 'boodschappen', name: 'Boodschappen', kind: 'out' }], rules: { winkel: 'boodschappen' }, fixed: {}, since: '' },
};

test('what only one phone changed is kept, from both phones', () => {
  const mine = copy(BASE);
  mine.state.cards[0].entries.push({ id: 'e2', at: '2026-11-21T10:00:00Z', kind: 'pay', delta: -400 }); // paid at the till here
  mine.bank.rules.bakker = 'boodschappen';
  const theirs = copy(BASE);
  theirs.bank.txs[1].cat = 'boodschappen'; // sorted on the other phone
  theirs.bank.txs.push(tx('t3', -900)); // and a new bank file
  delete theirs.bank.rules.winkel;
  const joined = sync.merge(BASE, mine, theirs);
  assert.deepEqual(joined.state.cards[0].entries.map((entry) => entry.id), ['e1', 'e2']);
  assert.equal(joined.bank.txs.find((each) => each.id === 't2').cat, 'boodschappen');
  assert.deepEqual(joined.bank.txs.map((each) => each.id), ['t1', 't2', 't3']);
  assert.deepEqual(joined.bank.rules, { bakker: 'boodschappen' }); // added here, removed there
});

test('what one phone removed stays away, and where both changed one value this phone wins', () => {
  const mine = copy(BASE);
  mine.bank.txs = mine.bank.txs.filter((each) => each.id !== 't1');
  mine.bank.since = '2026-06-01';
  const theirs = copy(BASE);
  theirs.bank.since = '2026-01-01';
  theirs.state.cards = []; // the card was removed there
  const joined = sync.merge(BASE, mine, theirs);
  assert.deepEqual(joined.bank.txs.map((each) => each.id), ['t2']);
  assert.equal(joined.bank.since, '2026-06-01');
  assert.deepEqual(joined.state.cards, []);
  assert.deepEqual(sync.merge(BASE, copy(BASE), theirs), theirs); // nothing changed here: theirs as it is
  assert.deepEqual(sync.merge(BASE, mine, copy(BASE)), mine);
});

test('two phones that book the same monthly payment keep one', () => {
  const account = { id: 'S-test0001', name: 'Speelwinkel', bank: 'Saldo', shop: 'Speelwinkel', balance: 3000, through: '2026-09-01', uploaded: '2026-09-01T00:00:00Z',
    monthly: [{ name: 'Spel pas!', cents: -1000, day: 31, next: '2026-10' }] };
  const base = { ...copy(BASE.bank), accounts: [account] };
  const [mine, theirs] = [copy(base), copy(base)];
  const [here] = bank.catchUp(mine, '2026-10-31');
  const [there] = bank.catchUp(theirs, '2026-10-31');
  assert.equal(here.id, 'S-test0001.2026-10-31.Spelpas');
  assert.equal(here.id, there.id);
  assert.equal(sync.merge(base, mine, theirs).txs.filter((each) => each.acc === 'S-test0001').length, 1);
  assert.doesNotThrow(() => bank.parseBank(mine));
  assert.notEqual(bank.payFrom(mine, account, '2026-10-31', -1000, 'Spel pas!').id, here.id); // by hand: a new one
});

test('data locked with the household key opens with it, and with nothing else', async () => {
  const household = sync.rand(32);
  const json = JSON.stringify({ ...BASE, filler: 'x'.repeat(300000) }); // larger than one chunk of the base64 helper
  const sealed = await sync.sealData(household, json);
  assert.ok(sealed.length < 10000, 'squeezed before it is locked');
  assert.equal(await sync.openData(household, sealed), json);
  await assert.rejects(sync.openData(sync.rand(32), sealed));
});

test('a passkey key or an invite code unlocks the household key', async () => {
  const household = sync.rand(32);
  const passkey = sync.rand(32);
  const code = sync.b64u(sync.rand(16));
  assert.ok(sync.isCode(code));
  assert.ok(!sync.isCode(`${code} `) && !sync.isCode('kort'));
  assert.deepEqual(await sync.unwrap(passkey, 'kassa wrap', await sync.wrap(passkey, 'kassa wrap', household)), household);
  const invite = await sync.wrap(sync.fromB64u(code), 'kassa invite', household);
  assert.deepEqual(await sync.unwrap(sync.fromB64u(code), 'kassa invite', invite), household);
  await assert.rejects(sync.unwrap(passkey, 'kassa invite', invite));
  assert.equal(await sync.tokenOf(household), await sync.tokenOf(household.slice()));
  assert.match(await sync.tokenOf(household), /^[0-9a-f]{64}$/);
  assert.notEqual(await sync.inviteId(code), code);
});
