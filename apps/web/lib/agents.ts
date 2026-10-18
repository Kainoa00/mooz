import { randomInt } from "node:crypto";
import type { Db } from "./db";
import { HttpError } from "./http";
import { hashSecret, newId, newSecret } from "./ids";
import { parseAgentName } from "./names";
import type { Participant } from "./rooms";

export const AGENT_CODE_TTL_MS = 10 * 60 * 1000;

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
  name: string;
  ownerIdentity: string;
  ownerName: string;
}

export type ClaimStatus =
  | { status: "pending" }
  | { status: "denied" }
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

function takenNames(db: Db, slug: string): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM participants WHERE room_slug = ?
       UNION ALL
       SELECT agent_name FROM agent_requests WHERE room_slug = ? AND status != 'denied'`,
    )
    .all(slug, slug) as { name: string }[];
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
 * Redeem a code for a pending join request. The code is burned only if the
 * request is created, so a rejected name can be retried with the same code.
 */
export function claimAgentCode(
  db: Db,
  input: { code: unknown; name: unknown },
): { requestId: string; claimSecret: string; slug: string; status: "pending" } {
  const invalid = new HttpError(400, "invalid_code", "That code is invalid, used, or expired");
  if (typeof input.code !== "string") throw invalid;
  const codeHash = hashSecret(normalizeCode(input.code));

  return transaction(db, () => {
    const row = db
      .prepare(
        "SELECT room_slug, owner_identity FROM agent_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
      )
      .get(codeHash, Date.now()) as { room_slug: string; owner_identity: string } | undefined;
    if (!row) throw invalid;

    const name = parseAgentName(input.name, takenNames(db, row.room_slug));
    db.prepare("UPDATE agent_codes SET used_at = ? WHERE code_hash = ?").run(Date.now(), codeHash);

    const requestId = newId("r");
    const claimSecret = newSecret();
    db.prepare(
      `INSERT INTO agent_requests
         (id, room_slug, owner_identity, agent_name, agent_identity, claim_secret_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(requestId, row.room_slug, row.owner_identity, name, newId("a"), hashSecret(claimSecret), Date.now());
    return { requestId, claimSecret, slug: row.room_slug, status: "pending" as const };
  });
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
  const row = db
    .prepare("SELECT status FROM agent_requests WHERE id = ? AND room_slug = ?")
    .get(input.requestId, input.slug) as { status: string } | undefined;
  if (!row) throw new HttpError(404, "request_not_found", "No such agent request");
  if (row.status !== "pending") {
    throw new HttpError(409, "already_decided", "This agent request was already decided");
  }
  db.prepare("UPDATE agent_requests SET status = ?, decided_at = ? WHERE id = ?").run(
    input.approve ? "approved" : "denied",
    Date.now(),
    input.requestId,
  );
}

/** What a bridge sees when it polls. Unknown ids and wrong secrets look the same. */
export function getClaimStatus(db: Db, requestId: string, claimSecret: string | undefined): ClaimStatus {
  const row = claimSecret
    ? (db
        .prepare(
          `SELECT r.status, r.room_slug, r.agent_name, r.agent_identity, r.owner_identity, p.name AS owner_name
           FROM agent_requests r JOIN participants p ON p.identity = r.owner_identity
           WHERE r.id = ? AND r.claim_secret_hash = ?`,
        )
        .get(requestId, hashSecret(claimSecret)) as
        | {
            status: "pending" | "approved" | "denied";
            room_slug: string;
            agent_name: string;
            agent_identity: string;
            owner_identity: string;
            owner_name: string;
          }
        | undefined)
    : undefined;
  if (!row) throw new HttpError(404, "request_not_found", "No such agent request");
  if (row.status !== "approved") return { status: row.status };
  return {
    status: "approved",
    agent: {
      identity: row.agent_identity,
      slug: row.room_slug,
      name: row.agent_name,
      ownerIdentity: row.owner_identity,
      ownerName: row.owner_name,
    },
  };
}
