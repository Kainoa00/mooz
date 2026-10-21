import { transaction } from "./agents";
import type { Db } from "./db";
import { forgetNames } from "./names";
import { pruneExpiredWindows } from "./rate-limit";
import { SESSION_TTL_MS } from "./rooms";

/**
 * What's left after a meeting. People, their agent codes and their agents' requests (names,
 * who brought what) go when the meeting ends, or once they've expired if LiveKit never says
 * it ended, and so do the names worked out in memory for name checks. The room itself (its
 * link, the host secret's hash, the notes policy, when it was last joined and when the webhook
 * last spoke of its meeting) is a setting, kept for 30 days after its last join.
 */

export const ROOM_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** A request older than this goes, unless its agent is approved and still in the meeting. */
export const REQUEST_TTL_MS = SESSION_TTL_MS;
/** The sweep runs at most this often (on room creation and joins). */
export const SWEEP_EVERY_MS = 60_000;

const LAST_SWEEP = Symbol.for("mooz.lastSweep");

/** Deletes everyone and everything of the rooms `where` picks out (participants last, for the foreign keys). */
function forgetRooms(db: Db, where: string, args: (string | number)[]): number {
  let changes = 0;
  for (const table of ["agent_codes", "agent_requests", "participants"]) {
    changes += Number(db.prepare(`DELETE FROM ${table} WHERE room_slug IN (${where})`).run(...args).changes);
  }
  return changes;
}

/** Old pages in the write-ahead log still hold what was deleted; fold them in and empty it. */
function checkpoint(db: Db): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** LiveKit says the meeting ended (everyone left): forget who was there. The room stays. */
export function endMeeting(db: Db, slug: string): number {
  forgetNames();
  const changes = transaction(db, () => {
    db.prepare("UPDATE rooms SET webhook_at = NULL WHERE slug = ?").run(slug);
    return forgetRooms(db, "?", [slug]);
  });
  if (changes > 0) checkpoint(db);
  return changes;
}

/** Deletes whatever has expired; returns how many rows went. */
export function sweep(db: Db, now = Date.now()): number {
  const changes = transaction(db, () => {
    const expired = "SELECT identity FROM participants WHERE expires_at IS NULL OR expires_at <= ?";
    const runs = [
      // Codes last 10 minutes; a used one is only a hash nobody can redeem.
      db.prepare("DELETE FROM agent_codes WHERE expires_at <= ?").run(now),
      db.prepare(`DELETE FROM agent_codes WHERE owner_identity IN (${expired})`).run(now),
      // An agent goes with its owner's session, and its request after a day unless it's still here.
      db
        .prepare(
          `DELETE FROM agent_requests WHERE owner_identity IN (${expired})
             OR (created_at <= ? AND NOT (status = 'approved' AND left_at IS NULL))`,
        )
        .run(now, now - REQUEST_TTL_MS),
      db.prepare("DELETE FROM participants WHERE expires_at IS NULL OR expires_at <= ?").run(now),
      // A meeting nobody is left in, though LiveKit never said it ended: its webhook time goes too.
      db
        .prepare(
          "UPDATE rooms SET webhook_at = NULL WHERE webhook_at IS NOT NULL AND slug NOT IN (SELECT room_slug FROM participants)",
        )
        .run(),
    ];
    let total = runs.reduce((n, r) => n + Number(r.changes), 0);
    const idle = "SELECT slug FROM rooms WHERE last_active_at IS NULL OR last_active_at <= ?";
    total += forgetRooms(db, idle, [now - ROOM_IDLE_MS]);
    total += Number(db.prepare(`DELETE FROM rooms WHERE slug IN (${idle})`).run(now - ROOM_IDLE_MS).changes);
    return total;
  });
  if (changes > 0) {
    checkpoint(db);
    forgetNames(); // whoever went may have been in the names worked out for name checks
  }
  // Rate-limit counts name meetings and people too: they go once their window is over.
  pruneExpiredWindows(now);
  return changes;
}

/** Sweeps if the last sweep was over a minute ago; null if it didn't run. */
export function maybeSweep(db: Db, now = Date.now()): number | null {
  const g = globalThis as unknown as Record<symbol, number | undefined>;
  const last = g[LAST_SWEEP];
  if (last !== undefined && now - last < SWEEP_EVERY_MS && now >= last) return null;
  g[LAST_SWEEP] = now;
  return sweep(db, now);
}

export function resetSweepForTests(): void {
  delete (globalThis as unknown as Record<symbol, number | undefined>)[LAST_SWEEP];
}
