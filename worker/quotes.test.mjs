// Run with: node --test (from the project folder)
import test from 'node:test';
import assert from 'node:assert/strict';
import { find, isSymbols, prices } from './quotes.js';

// Yahoo's answers, cut down to the fields that are read
const META = {
  'ASML.AS': { regularMarketPrice: 600, currency: 'EUR' },
  AAPL: { regularMarketPrice: 200, currency: 'USD' },
  'SHEL.L': { regularMarketPrice: 2500, currency: 'GBp' },
  'USDEUR=X': { regularMarketPrice: 0.9, currency: 'EUR' },
  'GBPEUR=X': { regularMarketPrice: 1.2, currency: 'EUR' },
};
const asked = [];
globalThis.fetch = async (address) => {
  const url = new URL(address);
  asked.push(url.pathname);
  if (url.pathname === '/v1/finance/search') {
    return Response.json({ quotes: [
      { symbol: 'ASML.AS', longname: 'ASML Holding N.V.', exchDisp: 'Amsterdam', quoteType: 'EQUITY' },
      { symbol: 'ASML=F', shortname: 'a future', quoteType: 'FUTURE' },
    ] });
  }
  const meta = META[decodeURIComponent(url.pathname.split('/').pop())];
  return meta ? Response.json({ chart: { result: [{ meta }] } }) : new Response(null, { status: 404 });
};

test('prices come in euros, whatever the exchange quotes in', async () => {
  const got = await prices(['ASML.AS', 'AAPL', 'SHEL.L', 'NOPE', 'AAPL']);
  assert.equal(got['ASML.AS'], 600);
  assert.equal(got.AAPL, 180);
  assert.equal(got['SHEL.L'], 30); // 2500 pence
  assert.equal(got.NOPE, null);
  assert.equal(asked.filter((path) => path.endsWith('USDEUR%3DX')).length, 1); // a rate is asked once
});

test('a search finds shares and funds only', async () => {
  assert.deepEqual(await find('asml'), [{ id: 'ASML.AS', name: 'ASML Holding N.V.', where: 'Amsterdam' }]);
});

test('only a short list of plain symbols is asked for', () => {
  assert.ok(isSymbols(['ASML.AS', 'BRK-B', '^AEX']));
  assert.ok(!isSymbols(['']));
  assert.ok(!isSymbols(['a/b']));
  assert.ok(!isSymbols(Array(31).fill('A')));
});
