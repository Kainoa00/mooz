import {
  PENDING_TTL_MS,
  activeAgentNames,
  participantNames,
  transaction,
  type AgentIdentity,
} from "./agents";
import { forgetAgent } from "./connector-queue";
import { getOwned, requireOwnerKey } from "./connectors";
import type { Db } from "./db";
import { HttpError } from "./http";
import { hashSecret, newId, newSecret } from "./ids";
import { parseAgentName } from "./names";
import type { Participant } from "./rooms";
import { requireParticipant } from "./session";

/**
 * A connector comes into a meeting as an agent run from its owner's browser tab. It
 * goes through the same host approval as a bridge agent; once approved, the owner's
 * tab (proven by their participant cookie and the owner cookie the connector belongs to)
 * can get its token, again after a reload, until the agent is removed, its owner takes it
 * out, the meeting ends, or it has been gone from the meeting for more than a couple of
 * minutes (then its questions go too).
 * A connector is in one meeting at a time: bringing it to another takes it out of the first.
 */

/** How long a connector agent may be away (a reload, a dropped connection) and still come back. */
export const LEFT_GRACE_MS = 2 * 60 * 1000;

export interface ConnectorAgent extends AgentIdentity {
  requestId: string;
  door: "connector";
  app: string;
  connectorId: string;
}

export type JoinStatus = "pending" | "approved" | "denied" | "revoked" | "expired";

/** An agent to disconnect from LiveKit (its request was just revoked). */
export interface Kick {
  livekitRoom: string;
  identity: string;
}

const notFound = () => new HttpError(404, "request_not_found", "No such agent request");

interface Row {
  id: string;
  status: Exclude<JoinStatus, "expired">;
  created_at: number;
  left_at: number | null;
  room_slug: string;
  livekit_room: string;
  agent_name: string;
  agent_identity: string;
  owner_identity: string;
  owner_name: string;
  connector_id: string;
  app: string;
}

const SELECT = `
  SELECT r.id, r.status, r.created_at, r.left_at, r.room_slug, rm.livekit_room, r.agent_name, r.agent_identity,
         r.owner_identity, p.name AS owner_name, r.connector_id, c.app
  FROM agent_requests r
  JOIN participants p ON p.identity = r.owner_identity
  JOIN rooms rm ON rm.slug = r.room_slug
  JOIN connectors c ON c.id = r.connector_id
  WHERE r.door = 'connector'`;

function toAgent(row: Row): ConnectorAgent {
  return {
    requestId: row.id,
    identity: row.agent_identity,
    slug: row.room_slug,
    livekitRoom: row.livekit_room,
    name: row.agent_name,
    ownerIdentity: row.owner_identity,
    ownerName: row.owner_name,
    door: "connector",
    app: row.app,
    connectorId: row.connector_id,
  };
}

/** Revoke a connector's pending and approved requests; returns the agents to disconnect. */
function revokeLive(db: Db, connectorId: string): Kick[] {
  const live = db
    .prepare(
      `SELECT r.agent_identity, rm.livekit_room, r.status FROM agent_requests r JOIN rooms rm ON rm.slug = r.room_slug
       WHERE r.connector_id = ? AND r.status IN ('pending', 'approved')`,
    )
    .all(connectorId) as { agent_identity: string; livekit_room: string; status: string }[];
  db.prepare(
    `UPDATE agent_requests SET status = 'revoked', decided_at = COALESCE(decided_at, ?)
     WHERE connector_id = ? AND status IN ('pending', 'approved')`,
  ).run(Date.now(), connectorId);
  return live
    .filter((r) => r.status === "approved")
    .map((r) => ({ livekitRoom: r.livekit_room, identity: r.agent_identity }));
}

/** The owner asks to bring their connector into the meeting they're in. */
export function requestConnectorJoin(
  db: Db,
  owner: Participant,
  ownerKey: string,
  connectorId: unknown,
): { requestId: string; status: "pending"; superseded: Kick[] } {
  if (typeof connectorId !== "string") throw new HttpError(404, "connector_not_found", "No such connector");
  const connector = getOwned(db, ownerKey, connectorId);
  return transaction(db, () => {
    const superseded = revokeLive(db, connector.id);
    const name = parseAgentName(connector.name, [
      ...participantNames(db, owner.slug),
      ...activeAgentNames(db, owner.slug),
    ]);
    const requestId = newId("r");
    db.prepare(
      `INSERT INTO agent_requests
         (id, room_slug, owner_identity, agent_name, agent_identity, claim_secret_hash, status, created_at,
          door, connector_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'connector', ?)`,
    ).run(
      requestId,
      owner.slug,
      owner.identity,
      name,
      newId("a"),
      // No bearer claim: the owner's cookies authenticate the tab. Unusable by design.
      hashSecret(newSecret()),
      Date.now(),
      connector.id,
    );
    return { requestId, status: "pending" as const, superseded };
  });
}

/** The request, if it's this participant's and its connector belongs to this owner key. */
function ownedRow(db: Db, owner: Participant, ownerKey: string, requestId: string): Row {
  const row = db
    .prepare(`${SELECT} AND r.id = ? AND r.owner_identity = ? AND r.room_slug = ? AND c.owner_hash = ?`)
    .get(requestId, owner.identity, owner.slug, hashSecret(ownerKey)) as Row | undefined;
  if (!row) throw notFound();
  return row;
}

/** Away too long: it has to be brought in (and approved) again, and its questions go. */
function expireIfGone(db: Db, row: Row, now: number): Row {
  if (row.status !== "approved" || row.left_at === null || now - row.left_at <= LEFT_GRACE_MS) return row;
  db.prepare("UPDATE agent_requests SET status = 'revoked' WHERE id = ? AND status = 'approved'").run(row.id);
  forgetAgent(row.agent_identity);
  return { ...row, status: "revoked" };
}

/** What the owner's tab sees while it waits for the host (and after). */
export function connectorJoinStatus(
  db: Db,
  owner: Participant,
  ownerKey: string,
  requestId: string,
  now = Date.now(),
): JoinStatus {
  const row = expireIfGone(db, ownedRow(db, owner, ownerKey, requestId), now);
  if (row.status === "pending" && now - row.created_at > PENDING_TTL_MS) return "expired";
  return row.status;
}

/** The approved agent, for minting its token in the owner's tab. */
export function connectorAgentFor(
  db: Db,
  owner: Participant,
  ownerKey: string,
  requestId: string,
  now = Date.now(),
): ConnectorAgent {
  const row = expireIfGone(db, ownedRow(db, owner, ownerKey, requestId), now);
  if (row.status !== "approved") {
    throw new HttpError(409, "not_approved", "This agent is not approved in this meeting");
  }
  return toAgent(row);
}

/** The approved agent behind a request, for its owner's tab (participant and owner cookie). */
export function requireConnectorAgent(db: Db, req: Request, slug: string, requestId: string): ConnectorAgent {
  return connectorAgentFor(db, requireParticipant(db, req, slug), requireOwnerKey(req), requestId);
}

/**
 * Where a connector is right now: its approved agent, if that agent is in a meeting (or
 * stepped out moments ago: a reload keeps its questions and lets its assistant answer).
 */
export function attachedConnectorAgent(db: Db, connectorId: string, now = Date.now()): ConnectorAgent | undefined {
  const row = db
    .prepare(`${SELECT} AND r.connector_id = ? AND r.status = 'approved' ORDER BY r.created_at DESC LIMIT 1`)
    .get(connectorId) as Row | undefined;
  if (!row) return undefined;
  return expireIfGone(db, row, now).status === "approved" ? toAgent(row) : undefined;
}

/** The owner cancels a request, or takes their agent out. Returns the agent to disconnect. */
export function withdrawConnector(db: Db, owner: Participant, ownerKey: string, requestId: string): Kick | undefined {
  const row = ownedRow(db, owner, ownerKey, requestId);
  db.prepare(
    `UPDATE agent_requests SET status = 'revoked', decided_at = COALESCE(decided_at, ?)
     WHERE id = ? AND status IN ('pending', 'approved')`,
  ).run(Date.now(), row.id);
  return row.status === "approved" ? { livekitRoom: row.livekit_room, identity: row.agent_identity } : undefined;
}

/**
 * LiveKit says a connector agent's tab joined (as session `sid`) or left. A "left" counts only
 * for the session that last joined, so a late one from a replaced connection changes nothing.
 * Coming back after the grace period doesn't count either: returns "expired" (kick it).
 */
export function noteConnectorPresence(
  db: Db,
  agentIdentity: string,
  sid: string | undefined,
  here: boolean,
  now = Date.now(),
): "expired" | undefined {
  const live = "agent_identity = ? AND door = 'connector' AND status = 'approved'";
  if (here) {
    const row = db.prepare(`SELECT left_at FROM agent_requests WHERE ${live}`).get(agentIdentity) as
      | { left_at: number | null }
      | undefined;
    if (row?.left_at != null && now - row.left_at > LEFT_GRACE_MS) {
      db.prepare(`UPDATE agent_requests SET status = 'revoked' WHERE ${live}`).run(agentIdentity);
      return "expired";
    }
    db.prepare(`UPDATE agent_requests SET left_at = NULL, session_sid = ? WHERE ${live}`).run(sid ?? null, agentIdentity);
  } else {
    db.prepare(`UPDATE agent_requests SET left_at = ? WHERE ${live} AND (session_sid IS NULL OR session_sid = ?)`).run(
      now,
      agentIdentity,
      sid ?? null,
    );
  }
  return undefined;
}

/** The meeting ended: its connector agents are done. Returns their identities. */
export function endRoomConnectors(db: Db, slug: string): string[] {
  const rows = db
    .prepare(
      `SELECT agent_identity FROM agent_requests WHERE room_slug = ? AND door = 'connector' AND status IN ('pending', 'approved')`,
    )
    .all(slug) as { agent_identity: string }[];
  db.prepare(
    `UPDATE agent_requests SET status = 'revoked', decided_at = COALESCE(decided_at, ?)
     WHERE room_slug = ? AND door = 'connector' AND status IN ('pending', 'approved')`,
  ).run(Date.now(), slug);
  return rows.map((r) => r.agent_identity);
}

/** Take a connector out of every meeting (it's being deleted). */
export function revokeConnectorAgents(db: Db, connectorId: string): Kick[] {
  return transaction(db, () => revokeLive(db, connectorId));
}
