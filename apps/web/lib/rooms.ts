import type { Db } from "./db";
import { hashSecret, newId, newRoomSlug, newSecret } from "./ids";

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

export function createRoom(db: Db): { slug: string; hostSecret: string } {
  const hostSecret = newSecret();
  const insert = db.prepare(
    "INSERT INTO rooms (slug, host_secret_hash, livekit_room, created_at) VALUES (?, ?, ?, ?)",
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = newRoomSlug();
    try {
      insert.run(slug, hashSecret(hostSecret), newId("lk"), Date.now());
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

export function isHost(db: Db, slug: string, secret: string | undefined): boolean {
  if (!secret) return false;
  const row = db
    .prepare("SELECT 1 FROM rooms WHERE slug = ? AND host_secret_hash = ?")
    .get(slug, hashSecret(secret));
  return row !== undefined;
}

export function addParticipant(
  db: Db,
  input: { slug: string; name: string; isHost: boolean },
): Participant & { secret: string } {
  const identity = newId("p");
  const secret = newSecret();
  db.prepare(
    `INSERT INTO participants (identity, room_slug, name, is_host, secret_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(identity, input.slug, input.name, input.isHost ? 1 : 0, hashSecret(secret), Date.now());
  return { identity, slug: input.slug, name: input.name, isHost: input.isHost, secret };
}

/** Update a returning participant's name (and host flag) in place, keeping their identity. */
export function renameParticipant(db: Db, participant: Participant, name: string, isHost: boolean): Participant {
  db.prepare("UPDATE participants SET name = ?, is_host = ? WHERE identity = ?").run(
    name,
    isHost ? 1 : 0,
    participant.identity,
  );
  return { ...participant, name, isHost };
}

export function findParticipant(
  db: Db,
  slug: string,
  secret: string | undefined,
): Participant | undefined {
  if (!secret) return undefined;
  const row = db
    .prepare(
      "SELECT identity, name, is_host FROM participants WHERE room_slug = ? AND secret_hash = ?",
    )
    .get(slug, hashSecret(secret)) as
    | { identity: string; name: string; is_host: number }
    | undefined;
  return row && { identity: row.identity, slug, name: row.name, isHost: row.is_host === 1 };
}
