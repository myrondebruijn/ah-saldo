// The Kassa server: one household's locked data, the locked copies of its key, and one invite at a time.
// It cannot read any of it: phones lock and unlock (see sync.js). A phone proves it belongs to the household
// with a token made from the household key; the server keeps only that token's hash.
//
// GET  /status        -> { ready }                    is there a household yet
// POST /setup         { token, cred, wrapped, data }  the first phone; only once
// GET  /key/:cred     -> { wrapped }                  a passkey's locked copy of the household key
// POST /key           { cred, wrapped }               (token) add a passkey
// GET  /vault?have=N  -> { version, data } or 204     (token) the data, unless version N is the newest
// PUT  /vault         { base, data } -> { version }   (token) only on top of the newest version, else 409
// PUT  /invite        { id, wrapped }                 (token) replaces the open invite; valid for a day
// GET  /invite/:id    -> { wrapped }                  the invited phone fetches it
// DELETE /invite                                      (token) the invite was used
//
// The Rabo link (Enable Banking): unlike the rest, the server sees these transactions, on their way to the phone;
// it keeps only the link itself (session and accounts). EB_KEY, the app's private key, is a secret; EB_APP its id.
// POST /bank/start    -> { url }                      (token) the page where Rabo asks for consent; then back to the app
// POST /bank/finish   { state, code } -> { until }    the app came back with these; no token, as it may open in Safari
// GET  /bank?from=D   -> { until, accounts }          (token) per account: booked lines since day D, and its balances

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX = 1_900_000; // D1 keeps at most 2 MB in one value

const json = (body, status = 200) => Response.json(body, { status });
const fail = (status) => new Response(null, { status });
const hash = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');
const isText = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[\w-]+$/.test(value);

async function allowed(request, db) {
  const given = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  const row = await db.prepare('SELECT token FROM vault WHERE id = 1').first();
  return Boolean(row && given && row.token === await hash(given));
}

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let signer; // the imported private key, kept while this copy of the worker lives

// An Enable Banking call, signed with the app's key; `ip` (the person's) tells the bank someone is there, so the
// call does not count against the few the bank allows a day without them. Throws 502 when the bank says no.
async function bank(env, method, path, { body, ip } = {}) {
  signer ??= crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(env.EB_KEY.replace(/-----[^-]+-----|\s/g, '')), (char) => char.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(Date.now() / 1000);
  const part = (value) => b64u(new TextEncoder().encode(JSON.stringify(value)));
  const signed = `${part({ typ: 'JWT', alg: 'RS256', kid: env.EB_APP })}.${part({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 })}`;
  const jwt = `${signed}.${b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signer, new TextEncoder().encode(signed)))}`;
  const response = await fetch(`https://api.enablebanking.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, ...(body && { 'Content-Type': 'application/json' }), ...(ip && { 'Psu-Ip-Address': ip }) },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) throw Object.assign(new Error(`bank ${response.status}`), { status: 502 });
  return response.json();
}

async function handle(request, env) {
  const db = env.DB;
  const url = new URL(request.url);
  const [, what, id] = url.pathname.split('/');
  const route = `${request.method} /${what}${id === undefined ? '' : '/:id'}`;
  const body = ['POST', 'PUT'].includes(request.method) ? await request.json() : {};
  const now = Date.now();

  if (route === 'GET /status') return json({ ready: Boolean(await db.prepare('SELECT 1 FROM vault WHERE id = 1').first()) });
  if (route === 'POST /setup') {
    if (!/^[0-9a-f]{64}$/.test(body.token) || !isText(body.cred) || !isText(body.wrapped) || !isText(body.data, MAX)) return fail(400);
    try {
      await db.batch([
        db.prepare('INSERT INTO vault (id, token, version, data, at) VALUES (1, ?, 1, ?, ?)').bind(await hash(body.token), body.data, now),
        db.prepare('INSERT INTO keys (cred, wrapped, at) VALUES (?, ?, ?)').bind(body.cred, body.wrapped, now),
      ]);
    } catch {
      return fail(409); // there is a household already
    }
    return json({ version: 1 });
  }
  if (route === 'GET /key/:id') {
    const row = await db.prepare('SELECT wrapped FROM keys WHERE cred = ?').bind(id).first();
    return row ? json(row) : fail(404);
  }
  if (url.pathname === '/bank/finish' && request.method === 'POST') {
    const row = await db.prepare('SELECT state, asked FROM bank WHERE id = 1').first();
    if (!row?.state || body.state !== row.state || now - row.asked > HOUR || !isText(body.code, 200)) return fail(403);
    const made = await bank(env, 'POST', '/sessions', { body: { code: body.code } });
    const accounts = made.accounts.filter((account) => account.account_id?.iban).map((account) => ({ uid: account.uid, iban: account.account_id.iban }));
    await db.prepare('UPDATE bank SET session = ?, accounts = ?, until = ?, state = NULL WHERE id = 1')
      .bind(made.session_id, JSON.stringify(accounts), made.access.valid_until).run();
    return json({ until: made.access.valid_until });
  }
  if (route === 'GET /invite/:id') {
    const row = await db.prepare('SELECT wrapped FROM invites WHERE id = ? AND until > ?').bind(id, now).first();
    return row ? json(row) : fail(404);
  }

  if (!await allowed(request, db)) return fail(401);
  if (route === 'POST /key') {
    if (!isText(body.cred) || !isText(body.wrapped)) return fail(400);
    await db.prepare('INSERT OR REPLACE INTO keys (cred, wrapped, at) VALUES (?, ?, ?)').bind(body.cred, body.wrapped, now).run();
    return fail(204);
  }
  if (route === 'GET /vault') {
    const row = await db.prepare('SELECT version, data FROM vault WHERE id = 1').first();
    return String(row.version) === url.searchParams.get('have') ? fail(204) : json(row);
  }
  if (route === 'PUT /vault') {
    if (!Number.isInteger(body.base) || !isText(body.data, MAX)) return fail(400);
    const { meta } = await db.prepare('UPDATE vault SET data = ?, version = version + 1, at = ? WHERE id = 1 AND version = ?')
      .bind(body.data, now, body.base).run();
    return meta.changes ? json({ version: body.base + 1 }) : fail(409);
  }
  if (route === 'PUT /invite') {
    if (!/^[0-9a-f]{64}$/.test(body.id) || !isText(body.wrapped)) return fail(400);
    await db.batch([
      db.prepare('DELETE FROM invites'),
      db.prepare('INSERT INTO invites (id, wrapped, until) VALUES (?, ?, ?)').bind(body.id, body.wrapped, now + DAY),
    ]);
    return fail(204);
  }
  if (url.pathname === '/bank/start' && request.method === 'POST') {
    const state = crypto.randomUUID();
    const { url: consent } = await bank(env, 'POST', '/auth', { body: {
      access: { valid_until: new Date(now + 179 * DAY).toISOString() }, // Rabo allows 180 days
      aspsp: { name: 'Rabobank', country: 'NL' }, state, redirect_url: `${env.ORIGIN}/ah-saldo/`, psu_type: 'personal',
    } });
    await db.prepare('INSERT INTO bank (id, state, asked) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, asked = excluded.asked')
      .bind(state, now).run();
    return json({ url: consent });
  }
  if (route === 'GET /bank') {
    const row = await db.prepare('SELECT accounts, until FROM bank WHERE id = 1 AND session IS NOT NULL').first();
    const from = url.searchParams.get('from') ?? '';
    if (!row) return fail(404);
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) return fail(400);
    const ip = request.headers.get('CF-Connecting-IP');
    const accounts = [];
    for (const { uid, iban } of JSON.parse(row.accounts)) {
      const txs = [];
      let next = '';
      do {
        const page = await bank(env, 'GET', `/accounts/${uid}/transactions?transaction_status=BOOK${from && `&date_from=${from}`}${next && `&continuation_key=${encodeURIComponent(next)}`}`, { ip });
        txs.push(...page.transactions);
        next = page.continuation_key;
      } while (next);
      const { balances } = await bank(env, 'GET', `/accounts/${uid}/balances`, { ip });
      accounts.push({ iban, txs, balances });
    }
    return json({ until: row.until, accounts });
  }
  if (route === 'DELETE /invite') {
    await db.prepare('DELETE FROM invites').run();
    return fail(204);
  }
  return fail(404);
}

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    let response;
    try {
      response = request.method === 'OPTIONS' ? fail(204) : await handle(request, env);
    } catch (error) {
      response = fail(error.status ?? 400); // the bank said no, or unreadable JSON and the like; nothing was written
    }
    response = new Response(response.body, response); // the headers of Response.json() cannot be changed in place
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  },
};
