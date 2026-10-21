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

/** The webhook spoke of this meeting (by its LiveKit room name). Forgotten when the meeting ends. */
export function noteRoomWebhook(db: Db, livekitRoom: string, now = Date.now()): void {
  db.prepare("UPDATE rooms SET webhook_at = ? WHERE livekit_room = ?").run(now, livekitRoom);
}

/**
 * When the webhook last spoke of this meeting, if it reaches this server at all; -1 if not. A
 * name held by someone whose arrival nobody reported is let go only when the webhook spoke of
 * the meeting after they joined: then it's working, for this meeting, since then.
 */
export function meetingHeardAt(db: Db, slug: string, now = Date.now()): number {
  if (!webhookArrives(db, now)) return -1;
  const row = db.prepare("SELECT webhook_at FROM rooms WHERE slug = ?").get(slug) as { webhook_at: number | null } | undefined;
  return row?.webhook_at ?? -1;
}
