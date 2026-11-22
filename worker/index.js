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

const DAY = 24 * 60 * 60 * 1000;
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

async function handle(request, db) {
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
      response = request.method === 'OPTIONS' ? fail(204) : await handle(request, env.DB);
    } catch {
      response = fail(400); // unreadable JSON and the like; nothing was written
    }
    response = new Response(response.body, response); // the headers of Response.json() cannot be changed in place
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  },
};
