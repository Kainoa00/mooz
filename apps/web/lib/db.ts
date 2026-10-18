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
