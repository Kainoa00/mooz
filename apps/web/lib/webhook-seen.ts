import type { Db } from "./db";

/**
 * Whether LiveKit's webhook reaches this server: only then can a join that never came into the
 * call be told from one whose arrival nobody reported. Kept in the database, across restarts.
 * A server that hasn't heard from it for a day (or ever) assumes it doesn't.
 */
const KEY = "webhook_seen_at";
const STALE_MS = 24 * 60 * 60 * 1000;
/** Written at most this often: every event would be a write for nothing. */
const WRITE_EVERY_MS = 60 * 1000;

export function noteWebhook(db: Db, now = Date.now()): void {
  db.prepare(
    `INSERT INTO server_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value < excluded.value - ?`,
  ).run(KEY, now, WRITE_EVERY_MS);
}

export function webhookArrives(db: Db, now = Date.now()): boolean {
  const row = db.prepare("SELECT value FROM server_state WHERE key = ?").get(KEY) as { value: number } | undefined;
  return row !== undefined && row.value > now - STALE_MS;
}
