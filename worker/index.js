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
//
// Notifications (Web Push, see push.js) to the phones that turned them on. Four times a day (wrangler.jsonc) the
// server looks for new Rabo lines itself; mornings it also warns before the link ends and while last month is open.
// GET  /push          -> { key }                      (token) the server's public key, to subscribe with
// PUT  /push          { endpoint, p256dh, auth, lang } -> { id }  (token) this phone wants notifications
// DELETE /push/:id                                    (token) not any more
// POST /month         { month, missing, spending, income, open }  (token) how far a phone got with closing last month:
//                                                     the account names still missing, or none and the month's totals

import { makeVapid, send } from './push.js';

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

// The booked lines of one account since day `from`, every page of them
async function booked(env, uid, from, ip) {
  const txs = [];
  let next = '';
  do {
    const page = await bank(env, 'GET', `/accounts/${uid}/transactions?transaction_status=BOOK${from && `&date_from=${from}`}${next && `&continuation_key=${encodeURIComponent(next)}`}`, { ip });
    txs.push(...page.transactions);
    next = page.continuation_key;
  } while (next);
  return txs;
}

// Remembers the highest line number per account that a phone or a check has seen, and returns the lines above the
// one remembered before: the new ones. An account seen for the first time has none yet.
async function newLines(db, found) {
  const row = await db.prepare("SELECT value FROM config WHERE name = 'seen'").first();
  const seen = row ? JSON.parse(row.value) : {};
  const fresh = [];
  for (const { iban, txs } of found) {
    const numbered = txs.filter((line) => line.status === 'BOOK' && /^\d+$/.test(line.entry_reference));
    if (iban in seen) fresh.push(...numbered.filter((line) => Number(line.entry_reference) > seen[iban]));
    seen[iban] = Math.max(seen[iban] ?? 0, ...numbered.map((line) => Number(line.entry_reference)));
  }
  await db.prepare("INSERT OR REPLACE INTO config (name, value) VALUES ('seen', ?)").bind(JSON.stringify(seen)).run();
  return fresh;
}

// ---------- notifications ----------

const T = (lang, nl, en) => (lang === 'en' ? en : nl);
const euro = (lang, cents) => new Intl.NumberFormat(T(lang, 'nl-NL', 'en-GB'), { style: 'currency', currency: 'EUR' }).format(Math.abs(cents) / 100);
const monthName = (lang, month) => {
  const name = new Date(`${month}-15T12:00:00Z`).toLocaleDateString(T(lang, 'nl-NL', 'en-GB'), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return name[0].toUpperCase() + name.slice(1);
};
const lineText = (lang, line) => {
  const debit = line.credit_debit_indicator === 'DBIT';
  const name = String((debit ? line.creditor : line.debtor)?.name || (line.remittance_information ?? []).join(' ') || '?').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${name} ${debit ? '−' : '+'} ${euro(lang, Math.round(Number(line.transaction_amount.amount) * 100))}`;
};

// The VAPID key pair, made the first time it is needed and kept in the database, so nobody has to handle it.
async function vapid(db) {
  const read = () => db.prepare("SELECT value FROM config WHERE name = 'vapid'").first();
  if (!await read()) await db.prepare("INSERT OR IGNORE INTO config (name, value) VALUES ('vapid', ?)").bind(JSON.stringify(await makeVapid())).run();
  return JSON.parse((await read()).value); // another request may have made one first
}

// Sends `make(lang)` ({ title, body }) to the phones with notifications on that `pick` picks; returns their ids.
// A phone that turned notifications off is forgotten.
async function notify(env, make, pick = () => true) {
  const { results } = await env.DB.prepare('SELECT * FROM phones').all();
  const chosen = results.filter(pick);
  if (!chosen.length) return [];
  const keys = await vapid(env.DB);
  await Promise.all(chosen.map(async (phone) => {
    const status = await send(phone, make(phone.lang), keys, `${env.ORIGIN}/ah-saldo/`).catch(() => 0);
    if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM phones WHERE id = ?').bind(phone.id).run();
    else if (status >= 400 || !status) console.log(`push refused: ${status}`);
  }));
  return chosen.map((phone) => phone.id);
}

// The other phones hear that something changed, at most once an hour each: sorting twenty lines is one ping.
async function pingOthers(env, me, now) {
  const ids = await notify(env, (lang) => ({ title: 'Kassa', body: T(lang, 'Op de andere telefoon is iets gewijzigd.', 'Something was changed on the other phone.') }),
    (phone) => phone.id !== me && phone.pinged < now - HOUR);
  for (const id of ids) await env.DB.prepare('UPDATE phones SET pinged = ? WHERE id = ?').bind(now, id).run();
}

// Four times a day: new Rabo lines. In the morning round also the end of the link and a month that is still open.
async function check(env, now) {
  const link = await env.DB.prepare('SELECT accounts, until FROM bank WHERE id = 1 AND session IS NOT NULL').first();
  if (link) {
    try {
      const from = new Date(now - 5 * DAY).toISOString().slice(0, 10);
      const found = [];
      // no ip: nobody is there, so these count against the few fetches a day the bank allows
      for (const { uid, iban } of JSON.parse(link.accounts)) found.push({ iban, txs: await booked(env, uid, from) });
      const fresh = await newLines(env.DB, found);
      if (fresh.length) {
        await notify(env, (lang) => ({
          title: fresh.length === 1 ? T(lang, 'Nieuw bij Rabo', 'New at Rabo') : T(lang, `${fresh.length} nieuwe transacties bij Rabo`, `${fresh.length} new transactions at Rabo`),
          body: [...fresh.slice(0, 4).map((line) => lineText(lang, line)), ...(fresh.length > 4 ? [T(lang, `en ${fresh.length - 4} meer`, `and ${fresh.length - 4} more`)] : [])].join('\n'),
        }));
      }
    } catch (error) {
      console.log(`rabo check failed: ${error.message}`); // the bank said no (too often today?); the next round tries again
    }
  }
  if (new Date(now).getUTCHours() !== 7) return;
  const left = link && Math.round((Date.parse(link.until) - now) / DAY);
  if (left === 14 || left === 3) {
    await notify(env, (lang) => ({ title: T(lang, 'Rabo-koppeling loopt af', 'Rabo link ending'),
      body: T(lang, `Over ${left} dagen. Koppel opnieuw in Kassa, bij Instellingen.`, `In ${left} days. Link again in Kassa, in Settings.`) }));
  }
  const day = new Date(now).getUTCDate();
  if (day < 2 || (day - 2) % 3) return; // the 2nd, 5th, 8th ...
  const month = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const state = await env.DB.prepare('SELECT closed, missing FROM months WHERE month = ?').bind(month).first();
  if (state?.closed) return;
  const missing = JSON.parse(state?.missing ?? '[]');
  await notify(env, (lang) => ({
    title: T(lang, `${monthName(lang, month)} is nog niet afgesloten`, `${monthName(lang, month)} is not closed yet`),
    body: missing.length ? T(lang, `Nog nodig: ${missing.join(', ')}.`, `Still needed: ${missing.join(', ')}.`)
      : T(lang, 'Open Kassa om de maand af te sluiten.', 'Open Kassa to close the month.'),
  }));
}

async function handle(request, env, ctx) {
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
    if (!meta.changes) return fail(409);
    ctx.waitUntil(pingOthers(env, isText(body.me, 64) ? body.me : '', now)); // `me`: the sending phone's notification id
    return json({ version: body.base + 1 });
  }
  if (route === 'GET /push') return json({ key: (await vapid(db)).key });
  if (route === 'PUT /push') {
    const service = /^https:\/\/(web\.push\.apple\.com|fcm\.googleapis\.com|[\w.-]+\.push\.services\.mozilla\.com|[\w.-]+\.notify\.windows\.com)\/\S{1,900}$/;
    if (!service.test(body.endpoint) || !isText(body.p256dh, 200) || !isText(body.auth, 100) || !['nl', 'en'].includes(body.lang)) return fail(400);
    const phone = (await hash(body.endpoint)).slice(0, 32);
    await db.prepare('INSERT INTO phones (id, endpoint, p256dh, auth, lang, pinged) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT (id) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang')
      .bind(phone, body.endpoint, body.p256dh, body.auth, body.lang).run();
    return json({ id: phone });
  }
  if (route === 'DELETE /push/:id') {
    await db.prepare('DELETE FROM phones WHERE id = ?').bind(id).run();
    return fail(204);
  }
  if (route === 'POST /month') {
    const { month, missing, spending, income, open } = body;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Array.isArray(missing) || missing.length > 20
      || !missing.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 40)
      || ![spending, income, open].every(Number.isInteger)) return fail(400);
    await db.prepare("INSERT OR IGNORE INTO months (month, closed, missing) VALUES (?, 0, '[]')").bind(month).run();
    // a closed month stays closed and is announced once, also when both phones close it at the same moment
    const { meta } = await db.prepare('UPDATE months SET closed = ?, missing = ? WHERE month = ? AND closed = 0')
      .bind(missing.length ? 0 : 1, JSON.stringify(missing), month).run();
    if (meta.changes && !missing.length) {
      const left = income - spending;
      ctx.waitUntil(notify(env, (lang) => ({
        title: T(lang, `${monthName(lang, month)} afgesloten`, `${monthName(lang, month)} closed`),
        body: T(lang, `Uitgegeven ${euro(lang, spending)} · binnengekomen ${euro(lang, income)} · ${left >= 0 ? 'over' : 'tekort'} ${euro(lang, left)}`,
          `Spent ${euro(lang, spending)} · came in ${euro(lang, income)} · ${left >= 0 ? 'left' : 'short'} ${euro(lang, left)}`)
          + (open ? T(lang, ` · nog ${open} in te delen`, ` · ${open} still to sort`) : ''),
      })));
    }
    return fail(204);
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
      const txs = await booked(env, uid, from, ip);
      const { balances } = await bank(env, 'GET', `/accounts/${uid}/balances`, { ip });
      accounts.push({ iban, txs, balances });
    }
    await newLines(db, accounts); // the phone has these now: the next check does not announce them
    return json({ until: row.until, accounts });
  }
  if (route === 'DELETE /invite') {
    await db.prepare('DELETE FROM invites').run();
    return fail(204);
  }
  return fail(404);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env, event.scheduledTime));
  },
  async fetch(request, env, ctx) {
    const cors = {
      'Access-Control-Allow-Origin': env.ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    let response;
    try {
      response = request.method === 'OPTIONS' ? fail(204) : await handle(request, env, ctx);
    } catch (error) {
      response = fail(error.status ?? 400); // the bank said no, or unreadable JSON and the like; nothing was written
    }
    response = new Response(response.body, response); // the headers of Response.json() cannot be changed in place
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  },
};
