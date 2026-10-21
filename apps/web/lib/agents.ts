import { randomInt } from "node:crypto";
import type { Db } from "./db";
import { HttpError } from "./http";
import { hashSecret, newId, newSecret } from "./ids";
import { parseAgentName } from "./names";
import { allow } from "./rate-limit";
import { SESSION_TTL_MS, type Participant } from "./rooms";

export const AGENT_CODE_TTL_MS = 10 * 60 * 1000;
/** After approval, the bridge must collect its token within this window. */
export const APPROVAL_WINDOW_MS = 10 * 60 * 1000;
/** Rejected names a single code may try before it is burned. */
export const MAX_NAME_ATTEMPTS = 5;
/** Pending requests the host never answers lapse, so they cannot squat names forever. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** How long an agent may be away (a reload, a dropped connection) and still come back. */
export const LEFT_GRACE_MS = 2 * 60 * 1000;
/** Claims a minute with one code, and across the server. */
export const CLAIMS_PER_CODE_PER_MINUTE = 10;
export const CLAIMS_PER_MINUTE = 120;

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
 * that left for good no longer holds its name.
 */
export function activeAgentNames(db: Db, slug: string): string[] {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT agent_name FROM agent_requests
       WHERE room_slug = ? AND ((status = 'approved' AND (left_at IS NULL OR left_at > ?))
         OR (status = 'pending' AND created_at > ?))`,
    )
    .all(slug, now - LEFT_GRACE_MS, now - PENDING_TTL_MS) as { agent_name: string }[];
  return rows.map((r) => r.agent_name);
}

/** Names of the people in the meeting now (not everyone who ever joined by its link). */
export function participantNames(db: Db, slug: string): string[] {
  const rows = db.prepare("SELECT name FROM participants WHERE room_slug = ? AND left_at IS NULL").all(slug) as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

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
  // Before the write lock, so a flood of claims can't hold it. The server-wide count goes first:
  // it bounds how many per-code counters a flood of made-up codes can create.
  if (!allow("claims:all", CLAIMS_PER_MINUTE, 60_000) || !allow(`claims-code:${codeHash}`, CLAIMS_PER_CODE_PER_MINUTE, 60_000)) {
    throw new HttpError(429, "rate_limited", "Too many tries just now. Try again in a minute.");
  }

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
