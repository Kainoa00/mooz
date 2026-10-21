import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** Append-only: each runs once, in order (PRAGMA user_version counts them). */
export const MIGRATIONS = [
  `CREATE TABLE rooms (
     slug TEXT PRIMARY KEY,
     host_secret_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE participants (
     identity TEXT PRIMARY KEY,
     room_slug TEXT NOT NULL REFERENCES rooms(slug),
     name TEXT NOT NULL,
     is_host INTEGER NOT NULL,
     secret_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX participants_by_room ON participants(room_slug);`,
  `CREATE TABLE agent_codes (
     code_hash TEXT PRIMARY KEY,
     room_slug TEXT NOT NULL REFERENCES rooms(slug),
     owner_identity TEXT NOT NULL REFERENCES participants(identity),
     expires_at INTEGER NOT NULL,
     used_at INTEGER
   );
   CREATE TABLE agent_requests (
     id TEXT PRIMARY KEY,
     room_slug TEXT NOT NULL REFERENCES rooms(slug),
     owner_identity TEXT NOT NULL REFERENCES participants(identity),
     agent_name TEXT NOT NULL,
     agent_identity TEXT NOT NULL UNIQUE,
     claim_secret_hash TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
     created_at INTEGER NOT NULL,
     decided_at INTEGER
   );
   CREATE INDEX agent_requests_by_room ON agent_requests(room_slug, status);`,
  // Security review: LiveKit rooms get an internal name unrelated to the public
  // link, codes count failed name attempts, and approvals can be revoked.
  `ALTER TABLE rooms ADD COLUMN livekit_room TEXT;
   UPDATE rooms SET livekit_room = slug WHERE livekit_room IS NULL;
   CREATE UNIQUE INDEX rooms_by_livekit_room ON rooms(livekit_room);
   ALTER TABLE agent_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE agent_requests_v3 (
     id TEXT PRIMARY KEY,
     room_slug TEXT NOT NULL REFERENCES rooms(slug),
     owner_identity TEXT NOT NULL REFERENCES participants(identity),
     agent_name TEXT NOT NULL,
     agent_identity TEXT NOT NULL UNIQUE,
     claim_secret_hash TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
     created_at INTEGER NOT NULL,
     decided_at INTEGER
   );
   INSERT INTO agent_requests_v3 SELECT * FROM agent_requests;
   DROP TABLE agent_requests;
   ALTER TABLE agent_requests_v3 RENAME TO agent_requests;
   CREATE INDEX agent_requests_by_room ON agent_requests(room_slug, status);`,
  // Security re-review: rooms that predate migration 3 still used their public slug
  // as the LiveKit room name, and each approval may mint exactly one token.
  `UPDATE rooms SET livekit_room = 'lk_' || lower(hex(randomblob(8))) WHERE livekit_room = slug;
   ALTER TABLE agent_requests ADD COLUMN token_issued_at INTEGER;`,
  // Meeting notes consent: the host's per-meeting policy and each person's opt-out.
  `ALTER TABLE rooms ADD COLUMN notes_allowed INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE participants ADD COLUMN notes_opt_out INTEGER NOT NULL DEFAULT 0;`,
  // Connectors: a private MCP link an owner pastes into Grok, Claude or ChatGPT once and
  // brings to any meeting here. A setting, so it outlives meetings; owned by a browser key.
  `CREATE TABLE connectors (
     id TEXT PRIMARY KEY,
     owner_hash TEXT NOT NULL,
     name TEXT NOT NULL,
     app TEXT NOT NULL CHECK (app IN ('grok', 'claude', 'chatgpt', 'other')),
     secret_hash TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     rotated_at INTEGER,
     last_used_at INTEGER
   );
   CREATE UNIQUE INDEX connectors_by_owner_name ON connectors(owner_hash, lower(name));`,
  // Two doors into a meeting: the bridge (mooz-agent) or a connector, run from its owner's tab.
  `ALTER TABLE agent_requests ADD COLUMN door TEXT NOT NULL DEFAULT 'bridge';
   ALTER TABLE agent_requests ADD COLUMN connector_id TEXT REFERENCES connectors(id) ON DELETE SET NULL;
   CREATE INDEX agent_requests_by_connector ON agent_requests(connector_id, status);`,
  // When a connector agent's tab left the meeting (cleared when it comes back).
  `ALTER TABLE agent_requests ADD COLUMN left_at INTEGER;`,
  // Which LiveKit session that tab is, so a late "left" from an old session doesn't count.
  `ALTER TABLE agent_requests ADD COLUMN session_sid TEXT;`,
  // When a person left the meeting, and as which session (names are checked against who's here).
  `ALTER TABLE participants ADD COLUMN left_at INTEGER;
   ALTER TABLE participants ADD COLUMN session_sid TEXT;`,
  // Nothing outlives its use: sessions expire on the server (24 h after the last join, like their
  // cookies), and a room is a setting kept 30 days after its last join (lib/cleanup.ts). Old rows
  // never recorded their last join: a session counts as joined when it was made, as its cookie was.
  `ALTER TABLE rooms ADD COLUMN last_active_at INTEGER;
   ALTER TABLE rooms ADD COLUMN host_expires_at INTEGER;
   ALTER TABLE participants ADD COLUMN expires_at INTEGER;
   UPDATE rooms SET last_active_at = created_at, host_expires_at = created_at + 86400000;
   UPDATE participants SET expires_at = created_at + 86400000;
   CREATE INDEX rooms_by_last_active ON rooms(last_active_at);
   CREATE INDEX participants_by_expiry ON participants(expires_at);
   CREATE INDEX agent_codes_by_expiry ON agent_codes(expires_at);
   CREATE INDEX agent_codes_by_owner ON agent_codes(owner_identity);
   CREATE INDEX agent_requests_by_owner ON agent_requests(owner_identity);`,
  // The one above counted a room as last used when it was made, so the first sweep deleted links
  // people may still meet on. Every room left counts as used at this upgrade instead.
  `UPDATE rooms SET last_active_at = MAX(COALESCE(last_active_at, 0), CAST(strftime('%s', 'now') AS INTEGER) * 1000);`,
  // What the server has noticed about itself (when LiveKit's webhook last got through: lib/webhook-seen.ts).
  `CREATE TABLE server_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`,
  // When the webhook last spoke of a meeting (cleared when it ends).
  `ALTER TABLE rooms ADD COLUMN webhook_at INTEGER;`,
];

function migrate(db: Db): void {
  db.exec("PRAGMA foreign_keys = ON");
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Deleted rows (names, after a meeting) are overwritten on disk, not just unlinked.
  db.exec("PRAGMA secure_delete = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

let instance: Db | undefined;

/** The process-wide database, opened lazily from MOOZ_DB_PATH. */
export function getDb(): Db {
  instance ??= openDb(process.env.MOOZ_DB_PATH ?? "./data/mooz.db");
  return instance;
}

export function resetDbForTests(): void {
  instance?.close();
  instance = undefined;
}
