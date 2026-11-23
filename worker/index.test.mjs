// Run with: node --test (from the project folder)
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

const TOKEN = 'a'.repeat(64);
const sha = async (text) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');

// The few statements PUT /vault runs, answered from memory
async function fakeDb() {
  const vault = { token: await sha(TOKEN), version: 1, data: 'first' };
  const config = new Map();
  const answer = (sql, args) => {
    if (sql.startsWith('SELECT token FROM vault')) return vault;
    if (sql.includes("FROM config WHERE name = 'app'")) return config.has('app') ? { value: config.get('app') } : null;
    if (sql.startsWith('UPDATE vault')) {
      if (args[2] !== vault.version) return { meta: { changes: 0 } };
      Object.assign(vault, { data: args[0], version: vault.version + 1 });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('INSERT OR REPLACE INTO config')) return config.set('app', args[0]);
    if (sql.startsWith('SELECT * FROM phones')) return { results: [] };
    throw new Error(`not expected: ${sql}`);
  };
  const prepare = (sql) => {
    let args = [];
    const made = { bind: (...given) => { args = given; return made; }, first: async () => answer(sql, args), run: async () => answer(sql, args), all: async () => answer(sql, args) };
    return made;
  };
  return { vault, prepare };
}

test('a Kassa older than the data may not write it', async () => {
  const DB = await fakeDb();
  const put = async (base, app) => (await worker.fetch(new Request('https://kassa.test/vault', {
    method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ base, data: `v${base}`, app }),
  }), { DB, ORIGIN: 'https://kassa.test' }, { waitUntil: (work) => work })).status;
  assert.equal(await put(1), 200); // before any newer Kassa wrote, the oldest still may
  assert.equal(await put(2, 1), 200);
  assert.equal(await put(3), 426); // now it would drop what the newer one added
  assert.equal(DB.vault.data, 'v2');
  assert.equal(await put(3, 1), 200);
  assert.equal(await put(4, 2), 200);
  assert.equal(await put(5, 1), 426);
  assert.equal(await put(5, 2), 200);
  assert.equal(await put(5, 2), 409); // and the other rule still holds: only on top of the newest version
});
