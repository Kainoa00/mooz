import type { Db } from "./db";
import { HttpError } from "./http";
import { hashSecret, newId, newRoomSlug, newSecret } from "./ids";

/** People a meeting keeps track of (everyone who joined; a rejoin reuses its row). */
export const MAX_PARTICIPANT_ROWS = 200;
/** Host and participant secrets work this long after their last join (as long as their cookies). */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface Room {
  slug: string;
  /** The LiveKit room name. Internal: knowing it does not let anyone join via the web app. */
  livekitRoom: string;
  createdAt: number;
}

export interface Participant {
  identity: string;
  slug: string;
  name: string;
  isHost: boolean;
}

export function createRoom(db: Db, now = Date.now()): { slug: string; hostSecret: string } {
  const hostSecret = newSecret();
  const insert = db.prepare(
    `INSERT INTO rooms (slug, host_secret_hash, livekit_room, created_at, last_active_at, host_expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = newRoomSlug();
    try {
      insert.run(slug, hashSecret(hostSecret), newId("lk"), now, now, now + SESSION_TTL_MS);
      return { slug, hostSecret };
    } catch (err) {
      if (!String(err).includes("UNIQUE")) throw err;
    }
  }
  throw new Error("Could not allocate a unique room slug");
}

export function getRoom(db: Db, slug: string): Room | undefined {
  const row = db
    .prepare("SELECT slug, livekit_room, created_at FROM rooms WHERE slug = ?")
    .get(slug) as { slug: string; livekit_room: string; created_at: number } | undefined;
  return row && { slug: row.slug, livekitRoom: row.livekit_room, createdAt: row.created_at };
}

/** Look a meeting up by its internal LiveKit room name (as LiveKit webhooks report it). */
export function getRoomByLivekitName(db: Db, livekitRoom: string): Room | undefined {
  const row = db.prepare("SELECT slug FROM rooms WHERE livekit_room = ?").get(livekitRoom) as
    | { slug: string }
    | undefined;
  return row && getRoom(db, row.slug);
}

export function isHost(db: Db, slug: string, secret: string | undefined, now = Date.now()): boolean {
  if (!secret) return false;
  const row = db
    .prepare("SELECT 1 FROM rooms WHERE slug = ? AND host_secret_hash = ? AND host_expires_at > ?")
    .get(slug, hashSecret(secret), now);
  return row !== undefined;
}

/** Someone joined: the room was used now, and a host's secret works for another day. */
export function touchRoom(db: Db, slug: string, host: boolean, now = Date.now()): void {
  db.prepare(
    "UPDATE rooms SET last_active_at = ?, host_expires_at = CASE WHEN ? THEN ? ELSE host_expires_at END WHERE slug = ?",
  ).run(now, host ? 1 : 0, now + SESSION_TTL_MS, slug);
}

export function addParticipant(
  db: Db,
  input: { slug: string; name: string; isHost: boolean },
  now = Date.now(),
): Participant & { secret: string } {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM participants WHERE room_slug = ?").get(input.slug) as { n: number };
  if (n >= MAX_PARTICIPANT_ROWS) throw new HttpError(409, "room_full", "This meeting is full.");
  const identity = newId("p");
  const secret = newSecret();
  db.prepare(
    `INSERT INTO participants (identity, room_slug, name, is_host, secret_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(identity, input.slug, input.name, input.isHost ? 1 : 0, hashSecret(secret), now, now + SESSION_TTL_MS);
  return { identity, slug: input.slug, name: input.name, isHost: input.isHost, secret };
}

/** Update a returning participant's name (and host flag) in place, keeping their identity for another day. */
export function renameParticipant(
  db: Db,
  participant: Participant,
  name: string,
  isHost: boolean,
  now = Date.now(),
): Participant {
  db.prepare("UPDATE participants SET name = ?, is_host = ?, left_at = NULL, expires_at = ? WHERE identity = ?").run(
    name,
    isHost ? 1 : 0,
    now + SESSION_TTL_MS,
    participant.identity,
  );
  return { ...participant, name, isHost };
}

/**
 * LiveKit says a person joined (as session `sid`) or left. A "left" counts only for the session
 * that last joined, so a late one from a replaced connection changes nothing.
 */
export function notePersonPresence(db: Db, identity: string, sid: string | undefined, here: boolean): void {
  if (here) {
    db.prepare("UPDATE participants SET left_at = NULL, session_sid = ? WHERE identity = ?").run(sid ?? null, identity);
  } else {
    db.prepare(
      "UPDATE participants SET left_at = ? WHERE identity = ? AND (session_sid IS NULL OR session_sid = ?)",
    ).run(Date.now(), identity, sid ?? null);
  }
}

/** Whether LiveKit has said this person came into the call (only where its webhook arrives). */
export function cameIntoCall(db: Db, identity: string): boolean {
  const row = db.prepare("SELECT session_sid FROM participants WHERE identity = ?").get(identity) as
    | { session_sid: string | null }
    | undefined;
  return row?.session_sid != null;
}

export function findParticipant(
  db: Db,
  slug: string,
  secret: string | undefined,
  now = Date.now(),
): Participant | undefined {
  if (!secret) return undefined;
  const row = db
    .prepare(
      "SELECT identity, name, is_host FROM participants WHERE room_slug = ? AND secret_hash = ? AND expires_at > ?",
    )
    .get(slug, hashSecret(secret), now) as
    | { identity: string; name: string; is_host: number }
    | undefined;
  return row && { identity: row.identity, slug, name: row.name, isHost: row.is_host === 1 };
}
