import { randomInt } from "node:crypto";
import type { Db } from "./db";
import { HttpError } from "./http";
import { hashSecret, newId, newSecret } from "./ids";
import { parseAgentName } from "./names";
import type { Participant } from "./rooms";

export const AGENT_CODE_TTL_MS = 10 * 60 * 1000;
/** After approval, the bridge must collect its token within this window. */
export const APPROVAL_WINDOW_MS = 10 * 60 * 1000;
/** Rejected names a single code may try before it is burned. */
export const MAX_NAME_ATTEMPTS = 5;

// No I, O, 0 or 1: codes are read off a screen and typed into a terminal.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12; // 60 bits

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatCode(raw: string): string {
  return raw.match(/.{4}/g)!.join("-");
}

export interface AgentIdentity {
  identity: string;
  slug: string;
  livekitRoom: string;
  name: string;
  ownerIdentity: string;
  ownerName: string;
}

export type ClaimStatus =
  | { status: "pending" | "denied" | "revoked" | "expired" }
  | { status: "approved"; agent: AgentIdentity };

export interface PendingRequest {
  id: string;
  agentName: string;
  ownerName: string;
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

/** Names of agents that are waiting or in the meeting (their wake words). */
export function activeAgentNames(db: Db, slug: string): string[] {
  const rows = db
    .prepare("SELECT agent_name FROM agent_requests WHERE room_slug = ? AND status IN ('pending', 'approved')")
    .all(slug) as { agent_name: string }[];
  return rows.map((r) => r.agent_name);
}

function participantNames(db: Db, slug: string): string[] {
  const rows = db.prepare("SELECT name FROM participants WHERE room_slug = ?").all(slug) as { name: string }[];
  return rows.map((r) => r.name);
}

function transaction<T>(db: Db, fn: () => T): T {
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
      name = parseAgentName(input.name, [...participantNames(db, row.room_slug), ...activeAgentNames(db, row.room_slug)]);
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
      `SELECT r.id, r.agent_name, p.name AS owner_name, r.created_at
       FROM agent_requests r JOIN participants p ON p.identity = r.owner_identity
       WHERE r.room_slug = ? AND r.status = 'pending' ORDER BY r.created_at`,
    )
    .all(slug) as { id: string; agent_name: string; owner_name: string; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agent_name,
    ownerName: r.owner_name,
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
      "UPDATE agent_requests SET status = ?, decided_at = ? WHERE id = ? AND room_slug = ? AND status = 'pending'",
    )
    .run(input.approve ? "approved" : "denied", Date.now(), input.requestId, input.slug);
  if (changes === 1) return;
  const exists = db
    .prepare("SELECT 1 FROM agent_requests WHERE id = ? AND room_slug = ?")
    .get(input.requestId, input.slug);
  if (!exists) throw new HttpError(404, "request_not_found", "No such agent request");
  throw new HttpError(409, "already_decided", "This agent request was already decided");
}

/** Host removes an approved agent. Its claim can never mint another token. */
export function revokeAgent(db: Db, input: { slug: string; agentIdentity: string }): void {
  const { changes } = db
    .prepare(
      "UPDATE agent_requests SET status = 'revoked', decided_at = ? WHERE agent_identity = ? AND room_slug = ? AND status = 'approved'",
    )
    .run(Date.now(), input.agentIdentity, input.slug);
  if (changes !== 1) throw new HttpError(404, "agent_not_found", "No such agent in this meeting");
}

/** What a bridge sees when it polls. Unknown ids and wrong secrets look the same. */
export function getClaimStatus(db: Db, requestId: string, claimSecret: string | undefined): ClaimStatus {
  const row = claimSecret
    ? (db
        .prepare(
          `SELECT r.status, r.decided_at, r.room_slug, rm.livekit_room, r.agent_name, r.agent_identity,
                  r.owner_identity, p.name AS owner_name
           FROM agent_requests r
           JOIN participants p ON p.identity = r.owner_identity
           JOIN rooms rm ON rm.slug = r.room_slug
           WHERE r.id = ? AND r.claim_secret_hash = ?`,
        )
        .get(requestId, hashSecret(claimSecret)) as
        | {
            status: "pending" | "approved" | "denied" | "revoked";
            decided_at: number | null;
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
  if (row.status !== "approved") return { status: row.status };
  if (Date.now() - (row.decided_at ?? 0) > APPROVAL_WINDOW_MS) return { status: "expired" };
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
