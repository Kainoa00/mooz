import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const MIGRATIONS = [
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
