-- The Kassa server's tables. Apply with: npx wrangler d1 execute kassa --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS keys (cred TEXT PRIMARY KEY, wrapped TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, wrapped TEXT NOT NULL, until INTEGER NOT NULL);
-- the Rabo link: one at a time; `state` and `asked` while the phone is away asking Rabo for consent
CREATE TABLE IF NOT EXISTS bank (id INTEGER PRIMARY KEY CHECK (id = 1), session TEXT, accounts TEXT, until TEXT, state TEXT, asked INTEGER);
-- notifications: the phones that turned them on (pinged: the last "something changed"), the server's VAPID key and
-- the highest Rabo line number seen (config), and how far closing each month got
CREATE TABLE IF NOT EXISTS phones (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, lang TEXT NOT NULL, pinged INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS config (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS months (month TEXT PRIMARY KEY, closed INTEGER NOT NULL DEFAULT 0, missing TEXT NOT NULL DEFAULT '[]');
