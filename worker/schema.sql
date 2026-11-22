-- The Kassa server's tables. Apply with: npx wrangler d1 execute kassa --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS keys (cred TEXT PRIMARY KEY, wrapped TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, wrapped TEXT NOT NULL, until INTEGER NOT NULL);
