import { randomInt } from "node:crypto";
import type { Db } from "./db";
import { HttpError } from "./http";
import { hashSecret, newId, newSecret } from "./ids";
import { AGENT_TOKEN_TTL_MS, TOKEN_TTL_MS } from "./livekit";
import { parseAgentName, parseDisplayName } from "./names";
import { SESSION_TTL_MS, type Participant } from "./rooms";
import { meetingHeardAt } from "./webhook-seen";

export const AGENT_CODE_TTL_MS = 10 * 60 * 1000;
/** After approval, the bridge must collect its token within this window. */
export const APPROVAL_WINDOW_MS = 10 * 60 * 1000;
/** Rejected names a single code may try before it is burned. */
export const MAX_NAME_ATTEMPTS = 5;
/** Pending requests the host never answers lapse, so they cannot squat names forever. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** How long an agent may be away (a reload, a dropped connection) and still come back. */
export const LEFT_GRACE_MS = 2 * 60 * 1000;
/**
 * How long a connector's approval counts as live though LiveKit never said the agent joined (its
 * webhook may not reach this server). After that, only an agent that really joined keeps it.
 */
export const UNJOINED_APPROVAL_MS = 24 * 60 * 60 * 1000;
/** An owner's checks on (and cancels of) the requests made with their codes, a minute. */
export const MY_REQUESTS_PER_MINUTE = 60;

// No I, O, 0 or 1: codes are read off a screen and typed into a terminal.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12; // 60 bits

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatCode(raw: string): string {
  return raw.match(/.{4}/g)!.join("-");
}

export type AgentDoor = "bridge" | "connector";

export interface AgentIdentity {
  identity: string;
  slug: string;
  livekitRoom: string;
  name: string;
  ownerIdentity: string;
  ownerName: string;
  /** How it came in (bridge when absent). */
  door?: AgentDoor;
  /** For a connector: the assistant app behind it. */
  app?: string;
}

export type ClaimStatus =
  | { status: "pending" | "denied" | "revoked" | "expired" }
  | { status: "approved"; agent: AgentIdentity };

/** A request made with one of my codes, as I see it. */
export interface MyAgentRequest {
  id: string;
  agentName: string;
  status: "pending" | "approved";
  createdAt: number;
}

export interface PendingRequest {
  id: string;
  agentName: string;
  ownerName: string;
  door: AgentDoor;
  createdAt: number;
}

/** A one-time code that lets `owner` bring an agent into their meeting. */
export function createAgentCode(db: Db, owner: Participant): { code: string; expiresAt: number } {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const expiresAt = Date.now() + AGENT_CODE_TTL_MS;
  db.prepare(
    "INSERT INTO agent_codes (code_hash, room_slug, owner_identity, expires_at) VALUES (?, ?, ?, ?)",
  ).run(hashSecret(raw), owner.slug, owner.identity, expiresAt);
  return { code: formatCode(raw), expiresAt };
}

/**
 * Names of agents that are waiting, in the meeting, or away for a moment (their wake words). One
 * that left for good no longer holds its name, and nor does a bridge approved that never
 * collected its token (its owner stopped it) once its approval has lapsed. Where LiveKit's
 * webhook arrives (and has spoken of the meeting since), a bridge that collected its token and
 * never came in holds its name only while that token works. Without the webhook nothing says an agent joined, so one keeps its name while
 * it could be in the call (a bridge's session can last a day), or while a connector's approval
 * counts as live.
 */
export function activeAgentNames(db: Db, slug: string, now = Date.now()): string[] {
  // A bridge's token works 5 minutes (a minute's slack for clocks: its expiry is LiveKit's to
  // check). Unless the webhook spoke of the meeting after it was issued, it may be in the call.
  const rows = db
    .prepare(
      `SELECT agent_name FROM agent_requests
       WHERE room_slug = ? AND ((status = 'approved' AND (left_at IS NULL OR left_at > ?)
           AND (session_sid IS NOT NULL
             OR (door = 'bridge' AND ((token_issued_at IS NULL AND decided_at > ?)
               OR token_issued_at > CASE WHEN ? > token_issued_at THEN ? ELSE ? END))
             OR (door = 'connector' AND decided_at > ?)))
         OR (status = 'pending' AND created_at > ?))`,
    )
    .all(
      slug,
      now - LEFT_GRACE_MS,
      now - APPROVAL_WINDOW_MS,
      meetingHeardAt(db, slug, now),
      now - AGENT_TOKEN_TTL_MS - 60_000,
      now - SESSION_TTL_MS,
      now - UNJOINED_APPROVAL_MS,
      now - PENDING_TTL_MS,
    ) as { agent_name: string }[];
  return rows.map((r) => r.agent_name);
}

/**
 * Names of the people in the meeting now, or away for a moment (a reload, a dropped connection),
 * as agents are: not everyone who ever joined by its link, and nobody whose session has ended.
 * Where LiveKit's webhook says who's in the meeting, someone who joined by the link but never
 * came into the call holds their name while their join token could still bring them in.
 * Without the webhook, everyone whose session is live counts.
 */
export function participantNames(db: Db, slug: string, now = Date.now()): string[] {
  const held = holdsName(db, slug, now);
  const rows = db
    .prepare(
      `SELECT name FROM participants WHERE ${HOLDS_NAME} AND session_sid IS NOT NULL
       UNION ALL
       SELECT name FROM (SELECT name FROM participants WHERE ${HOLDS_NAME} AND session_sid IS NULL
         ORDER BY expires_at DESC LIMIT ?)`,
    )
    .all(...held, ...held, MAX_UNSEEN_NAMES) as { name: string }[];
  return rows.map((r) => r.name);
}

// A session's expiry is SESSION_TTL_MS after its last /join, which minted its token. A join
// nobody reported coming in is let go once that token can't, if the webhook spoke of the
// meeting after it (so it would have reported them).
const HOLDS_NAME = `room_slug = ? AND (left_at IS NULL OR left_at > ?) AND expires_at > ?
  AND (session_sid IS NOT NULL OR expires_at > ? OR ? <= expires_at - ?)`;
const holdsName = (db: Db, slug: string, now: number) =>
  [slug, now - LEFT_GRACE_MS, now, now + SESSION_TTL_MS - TOKEN_TTL_MS, meetingHeardAt(db, slug, now), SESSION_TTL_MS] as const;

/**
 * Joins nobody has reported coming in whose names a name check counts: the most recent ones.
 * Every agent's name is checked against each, so a meeting stuffed with joins that never come in
 * can't make that slow, and nobody is turned away for it. One of the older ones who does come in
 * later, under a name an agent now answers to, is taken out of the call (isUnwelcomePerson).
 */
export const MAX_UNSEEN_NAMES = 2_000;

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Redeem a code for a pending join request. A rejected name does not burn the
 * code, but each rejection counts, so a code cannot be used to probe attendee
 * names. The response deliberately reveals nothing about the meeting.
 */
export function claimAgentCode(
  db: Db,
  input: { code: unknown; name: unknown },
): { requestId: string; claimSecret: string; status: "pending" } {
  const invalid = new HttpError(400, "invalid_code", "That code is invalid, used, or expired");
  if (typeof input.code !== "string") throw invalid;
  const codeHash = hashSecret(normalizeCode(input.code));
  // No rate limit: a made-up, used or expired code is refused at once, so junk can't use up a
  // limit that real codes need (and guessing one is hopeless: 60 bits, gone in 10 minutes, and
  // the host still decides). A real code may try MAX_NAME_ATTEMPTS names.

  const outcome = transaction(db, () => {
    const row = db
      .prepare(
        `SELECT room_slug, owner_identity FROM agent_codes
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?`,
      )
      .get(codeHash, Date.now(), MAX_NAME_ATTEMPTS) as { room_slug: string; owner_identity: string } | undefined;
    if (!row) throw invalid;

    let name: string;
    try {
      name = parseAgentName(input.name, participantNames(db, row.room_slug), activeAgentNames(db, row.room_slug));
    } catch (err) {
      db.prepare("UPDATE agent_codes SET attempts = attempts + 1 WHERE code_hash = ?").run(codeHash);
      return { rejected: err };
    }
    db.prepare("UPDATE agent_codes SET used_at = ? WHERE code_hash = ?").run(Date.now(), codeHash);

    const requestId = newId("r");
    const claimSecret = newSecret();
    db.prepare(
      `INSERT INTO agent_requests
         (id, room_slug, owner_identity, agent_name, agent_identity, claim_secret_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(requestId, row.room_slug, row.owner_identity, name, newId("a"), hashSecret(claimSecret), Date.now());
    return { claim: { requestId, claimSecret, status: "pending" as const } };
  });
  if ("rejected" in outcome) throw outcome.rejected;
  return outcome.claim;
}

export function listPendingRequests(db: Db, slug: string): PendingRequest[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.agent_name, p.name AS owner_name, r.door, r.created_at
       FROM agent_requests r JOIN participants p ON p.identity = r.owner_identity
       WHERE r.room_slug = ? AND r.status = 'pending' AND r.created_at > ? ORDER BY r.created_at`,
    )
    .all(slug, Date.now() - PENDING_TTL_MS) as {
    id: string;
    agent_name: string;
    owner_name: string;
    door: AgentDoor;
    created_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agent_name,
    ownerName: r.owner_name,
    door: r.door,
    createdAt: r.created_at,
  }));
}

export function decideAgentRequest(
  db: Db,
  input: { slug: string; requestId: string; approve: boolean },
): void {
  // A single conditional update, so concurrent approve/deny cannot both win.
  const { changes } = db
    .prepare(
      `UPDATE agent_requests SET status = ?, decided_at = ?
       WHERE id = ? AND room_slug = ? AND status = 'pending' AND created_at > ?`,
    )
    .run(input.approve ? "approved" : "denied", Date.now(), input.requestId, input.slug, Date.now() - PENDING_TTL_MS);
  if (changes === 1) return;
  const exists = db
    .prepare("SELECT 1 FROM agent_requests WHERE id = ? AND room_slug = ?")
    .get(input.requestId, input.slug);
  if (!exists) throw new HttpError(404, "request_not_found", "No such agent request");
  throw new HttpError(409, "already_decided", "This agent request was already decided");
}

/**
 * The agents brought with my codes that are waiting for the host or in the meeting, so a code
 * someone else used can't be credited to me unnoticed. Connector agents have their own panel.
 */
export function listMyAgentRequests(db: Db, owner: Participant, now = Date.now()): MyAgentRequest[] {
  const rows = db
    .prepare(
      `SELECT id, agent_name, status, created_at FROM agent_requests
       WHERE room_slug = ? AND owner_identity = ? AND door = 'bridge'
         AND ((status = 'pending' AND created_at > ?) OR (status = 'approved' AND (left_at IS NULL OR left_at > ?)))
       ORDER BY created_at`,
    )
    .all(owner.slug, owner.identity, now - PENDING_TTL_MS, now - LEFT_GRACE_MS) as {
    id: string;
    agent_name: string;
    status: "pending" | "approved";
    created_at: number;
  }[];
  return rows.map((r) => ({ id: r.id, agentName: r.agent_name, status: r.status, createdAt: r.created_at }));
}

/**
 * The owner takes back a request made with their code: one still waiting is declined (the
 * bridge hears "denied"), and an agent that's in is revoked, for the caller to remove from
 * the meeting. Repeatable, so a failed removal can be retried. Someone else's request is
 * "not found", whatever it is.
 */
export function withdrawMyAgentRequest(
  db: Db,
  owner: Participant,
  requestId: string,
  now = Date.now(),
): { remove: string | null } {
  return transaction(db, () => {
    const row = db
      .prepare(
        `SELECT status, agent_identity FROM agent_requests
         WHERE id = ? AND room_slug = ? AND owner_identity = ? AND door = 'bridge'`,
      )
      .get(requestId, owner.slug, owner.identity) as { status: string; agent_identity: string } | undefined;
    if (!row) throw new HttpError(404, "request_not_found", "No such agent request");
    if (row.status === "pending") {
      db.prepare("UPDATE agent_requests SET status = 'denied', decided_at = ? WHERE id = ?").run(now, requestId);
      return { remove: null };
    }
    if (row.status === "approved") {
      db.prepare("UPDATE agent_requests SET status = 'revoked', decided_at = ? WHERE id = ?").run(now, requestId);
    }
    return { remove: row.status === "approved" || row.status === "revoked" ? row.agent_identity : null };
  });
}

/**
 * Host removes an agent. Its claim can never mint another token, and the LiveKit
 * webhook kicks it if it reconnects with one it already holds. Repeatable, so a
 * failed disconnect can be retried.
 */
export function revokeAgent(db: Db, input: { slug: string; agentIdentity: string }): void {
  const { changes } = db
    .prepare(
      `UPDATE agent_requests SET status = 'revoked', decided_at = COALESCE(decided_at, ?)
       WHERE agent_identity = ? AND room_slug = ? AND status IN ('approved', 'revoked')`,
    )
    .run(Date.now(), input.agentIdentity, input.slug);
  if (changes !== 1) throw new HttpError(404, "agent_not_found", "No such agent in this meeting");
}

export function isRevokedAgent(db: Db, agentIdentity: string): boolean {
  return (
    db.prepare("SELECT 1 FROM agent_requests WHERE agent_identity = ? AND status = 'revoked'").get(agentIdentity) !==
    undefined
  );
}

/**
 * An agent LiveKit let in that has no approval here: removed by the host, or from a meeting
 * that ended (its rows are gone). A person's identity is never one.
 */
export function isUnwelcomeAgent(db: Db, identity: string): boolean {
  if (!identity.startsWith("a_")) return false;
  return (
    db.prepare("SELECT 1 FROM agent_requests WHERE agent_identity = ? AND status = 'approved'").get(identity) === undefined
  );
}

/**
 * A person LiveKit says came in under a name that an agent who arrived while they were away (or
 * before they first came in) now answers to: they kept their join token, so no join checked it
 * again. Their own words would wake that agent. `admitted` is the name LiveKit has for them, from
 * their token, which a later rejoin under another name doesn't change.
 */
export function isUnwelcomePerson(db: Db, identity: string, admitted?: string): boolean {
  // Only people: an agent has no participants row, and would match its own name.
  const row = db.prepare("SELECT room_slug, name FROM participants WHERE identity = ?").get(identity) as
    | { room_slug: string; name: string }
    | undefined;
  if (!row) return false;
  const agents = activeAgentNames(db, row.room_slug);
  return [row.name, admitted].some((name) => {
    if (!name) return false;
    try {
      parseDisplayName(name, agents);
      return false;
    } catch (err) {
      return err instanceof HttpError && err.code === "name_taken";
    }
  });
}

/**
 * A bridge LiveKit says is back after being away longer than LEFT_GRACE_MS (its owner's laptop
 * slept, say): its name was free meanwhile, so someone may have taken it fairly. If its name now
 * clashes with anyone here, the bridge is the one that goes (revoked, so it's taken out).
 */
export function revokeIfNameTakenWhileAway(db: Db, agentIdentity: string, now = Date.now()): boolean {
  const row = db
    .prepare(
      "SELECT room_slug, agent_name, left_at FROM agent_requests WHERE agent_identity = ? AND door = 'bridge' AND status = 'approved'",
    )
    .get(agentIdentity) as { room_slug: string; agent_name: string; left_at: number | null } | undefined;
  if (!row || row.left_at === null || row.left_at > now - LEFT_GRACE_MS) return false;
  try {
    // It's away, so neither list counts it.
    parseAgentName(row.agent_name, participantNames(db, row.room_slug, now), activeAgentNames(db, row.room_slug, now));
    return false;
  } catch (err) {
    if (!(err instanceof HttpError && err.code === "name_taken")) return false;
  }
  db.prepare("UPDATE agent_requests SET status = 'revoked' WHERE agent_identity = ? AND status = 'approved'").run(agentIdentity);
  return true;
}

/** Record that an approval's single token was handed out. False if it already was. */
export function markTokenIssued(db: Db, requestId: string): boolean {
  const { changes } = db
    .prepare("UPDATE agent_requests SET token_issued_at = ? WHERE id = ? AND token_issued_at IS NULL")
    .run(Date.now(), requestId);
  return changes === 1;
}

/** What a bridge sees when it polls. Unknown ids and wrong secrets look the same. */
export function getClaimStatus(db: Db, requestId: string, claimSecret: string | undefined): ClaimStatus {
  const row = claimSecret
    ? (db
        .prepare(
          `SELECT r.status, r.created_at, r.decided_at, r.token_issued_at, r.room_slug, rm.livekit_room,
                  r.agent_name, r.agent_identity, r.owner_identity, p.name AS owner_name
           FROM agent_requests r
           JOIN participants p ON p.identity = r.owner_identity
           JOIN rooms rm ON rm.slug = r.room_slug
           WHERE r.id = ? AND r.claim_secret_hash = ?`,
        )
        .get(requestId, hashSecret(claimSecret)) as
        | {
            status: "pending" | "approved" | "denied" | "revoked";
            created_at: number;
            decided_at: number | null;
            token_issued_at: number | null;
            room_slug: string;
            livekit_room: string;
            agent_name: string;
            agent_identity: string;
            owner_identity: string;
            owner_name: string;
          }
        | undefined)
    : undefined;
  if (!row) throw new HttpError(404, "request_not_found", "No such agent request");
  if (row.status === "pending" && Date.now() - row.created_at > PENDING_TTL_MS) return { status: "expired" };
  if (row.status !== "approved") return { status: row.status };
  if (row.token_issued_at !== null || Date.now() - (row.decided_at ?? 0) > APPROVAL_WINDOW_MS) {
    return { status: "expired" };
  }
  return {
    status: "approved",
    agent: {
      identity: row.agent_identity,
      slug: row.room_slug,
      livekitRoom: row.livekit_room,
      name: row.agent_name,
      ownerIdentity: row.owner_identity,
      ownerName: row.owner_name,
    },
  };
}

/** The claim secret a bridge sends as `authorization: Bearer <secret>`. */
export function bearer(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

/**
 * The bridge agent behind a request, for its own calls during the meeting (taking turns).
 * It must hold the claim secret, be approved with its token handed out, and still be in the
 * meeting as far as LiveKit has said.
 */
export function requireBridgeAgent(db: Db, requestId: string, claimSecret: string | undefined): AgentIdentity {
  const row = claimSecret
    ? (db
        .prepare(
          `SELECT r.status, r.token_issued_at, r.left_at, r.room_slug, rm.livekit_room, r.agent_name,
                  r.agent_identity, r.owner_identity, p.name AS owner_name, p.expires_at AS owner_expires_at
           FROM agent_requests r
           JOIN participants p ON p.identity = r.owner_identity
           JOIN rooms rm ON rm.slug = r.room_slug
           WHERE r.id = ? AND r.claim_secret_hash = ? AND r.door = 'bridge'`,
        )
        .get(requestId, hashSecret(claimSecret)) as
        | {
            status: string;
            token_issued_at: number | null;
            left_at: number | null;
            room_slug: string;
            livekit_room: string;
            agent_name: string;
            agent_identity: string;
            owner_identity: string;
            owner_name: string;
            owner_expires_at: number | null;
          }
        | undefined)
    : undefined;
  if (!row) throw new HttpError(404, "request_not_found", "No such agent request");
  if (row.status !== "approved" || row.token_issued_at === null || row.left_at !== null) {
    throw new HttpError(409, "not_in_meeting", "This agent is not in the meeting");
  }
  // An agent's standing is its owner's: it goes when their session does, and after a day at most.
  const now = Date.now();
  if ((row.owner_expires_at ?? 0) <= now || now - row.token_issued_at >= SESSION_TTL_MS) {
    throw new HttpError(409, "not_in_meeting", "This agent's approval has run out. Get a new code from the meeting.");
  }
  return {
    identity: row.agent_identity,
    slug: row.room_slug,
    livekitRoom: row.livekit_room,
    name: row.agent_name,
    ownerIdentity: row.owner_identity,
    ownerName: row.owner_name,
  };
}

/**
 * LiveKit says a bridge agent joined (as session `sid`) or left. A "left" counts only for the
 * session that last joined, so a late one from a replaced connection changes nothing. Returns
 * whether a "left" counted.
 */
export function noteBridgePresence(db: Db, agentIdentity: string, sid: string | undefined, here: boolean): boolean {
  const live = "agent_identity = ? AND door = 'bridge' AND status = 'approved'";
  if (here) {
    db.prepare(`UPDATE agent_requests SET left_at = NULL, session_sid = ? WHERE ${live}`).run(sid ?? null, agentIdentity);
    return false;
  }
  const { changes } = db
    .prepare(`UPDATE agent_requests SET left_at = ? WHERE ${live} AND (session_sid IS NULL OR session_sid = ?)`)
    .run(Date.now(), agentIdentity, sid ?? null);
  return changes > 0;
}
