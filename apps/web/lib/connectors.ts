import { isHttps, readCookie } from "./cookies";
import type { Db } from "./db";
import { envInt } from "./env";
import { HttpError } from "./http";
import { hashSecret, newId, newSecret } from "./ids";
import { parseAgentName } from "./names";

/**
 * Connectors: the private MCP link an owner pastes into the assistant app they already
 * use. It's set up once and brought to any meeting on this server. The link's secret
 * and the owner's browser key are stored hashed; the link is shown only when created
 * or rotated.
 */

export const CONNECTOR_APPS = ["grok", "claude", "chatgpt", "other"] as const;
export type ConnectorApp = (typeof CONNECTOR_APPS)[number];

/** The browser's long-lived owner key (HttpOnly): whoever holds it owns its connectors. */
export const OWNER_COOKIE = "mooz_owner";
/**
 * Over HTTPS the owner cookie is `__Host-` prefixed: browsers then refuse one set by any
 * other host (say, a sibling site under a shared tunnel domain), so nobody can plant an
 * owner key they know and later read the connectors made under it.
 */
export const OWNER_COOKIE_HTTPS = "__Host-mooz_owner";
export const OWNER_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
export const MAX_CONNECTORS_PER_OWNER = 10;
/** All this server keeps (each is a row in its database); MOOZ_MAX_CONNECTORS changes it. */
export const MAX_CONNECTORS = envInt("MOOZ_MAX_CONNECTORS", 10_000);
/**
 * A link never used in a meeting is deleted after this; one unused for long, after the next.
 * Only use in a meeting counts (lib/mcp route), so a flood of links can't be kept alive by
 * pinging them; it has to be brought into meetings and approved, link by link.
 */
export const UNUSED_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const IDLE_LINK_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Drop links never used in a meeting within a day, or not for half a year (unless one is in
 * a meeting right now), so abandoned ones, or most of a flood, don't stay forever.
 */
export function pruneConnectors(db: Db, now = Date.now()): void {
  db.prepare(
    `DELETE FROM connectors
     WHERE ((last_used_at IS NULL AND created_at < ?) OR COALESCE(last_used_at, created_at) < ?)
       AND id NOT IN (SELECT connector_id FROM agent_requests
                      WHERE connector_id IS NOT NULL AND status IN ('pending', 'approved'))`,
  ).run(now - UNUSED_LINK_TTL_MS, now - IDLE_LINK_TTL_MS);
}

export interface Connector {
  id: string;
  name: string;
  app: ConnectorApp;
  createdAt: number;
  rotatedAt: number | null;
  lastUsedAt: number | null;
}

interface Row {
  id: string;
  name: string;
  app: ConnectorApp;
  created_at: number;
  rotated_at: number | null;
  last_used_at: number | null;
}

const COLUMNS = "id, name, app, created_at, rotated_at, last_used_at";

function fromRow(row: Row): Connector {
  return {
    id: row.id,
    name: row.name,
    app: row.app,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    lastUsedAt: row.last_used_at,
  };
}

const notFound = () => new HttpError(404, "connector_not_found", "No such connector");

/** The request's owner key. Without one, every connector looks missing. */
export const ownerCookieName = (req: Request) => (isHttps(req) ? OWNER_COOKIE_HTTPS : OWNER_COOKIE);

/** This browser's owner key, if it has one. */
export function readOwnerKey(req: Request): string | undefined {
  return readCookie(req, ownerCookieName(req));
}

export function requireOwnerKey(req: Request): string {
  const owner = readOwnerKey(req);
  if (!owner) throw notFound();
  return owner;
}

function parseApp(value: unknown): ConnectorApp {
  if (typeof value === "string" && (CONNECTOR_APPS as readonly string[]).includes(value)) {
    return value as ConnectorApp;
  }
  throw new HttpError(400, "invalid_app", "Pick Grok, Claude, ChatGPT or Other");
}

/** The link the owner pastes into their assistant app. */
export function connectorUrl(origin: string, secret: string): string {
  return `${origin}/mcp/${secret}`;
}

export function createConnector(
  db: Db,
  ownerKey: string,
  input: { name: unknown; app: unknown },
): { connector: Connector; secret: string } {
  const ownerHash = hashSecret(ownerKey);
  pruneConnectors(db);
  const { total } = db.prepare("SELECT COUNT(*) AS total FROM connectors").get() as { total: number };
  if (total >= MAX_CONNECTORS) {
    throw new HttpError(503, "server_full", "This server can't keep any more connectors right now");
  }
  const mine = listConnectors(db, ownerKey);
  // Unique per owner here; per meeting it's checked again when it joins one.
  const name = parseAgentName(input.name, []);
  const app = parseApp(input.app);
  if (mine.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, "name_taken", `You already have a connector called "${name}"`);
  }
  if (mine.length >= MAX_CONNECTORS_PER_OWNER) {
    throw new HttpError(409, "too_many_connectors", `You can have at most ${MAX_CONNECTORS_PER_OWNER} connectors`);
  }
  const id = newId("c");
  const secret = newSecret();
  db.prepare(
    "INSERT INTO connectors (id, owner_hash, name, app, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, ownerHash, name, app, hashSecret(secret), Date.now());
  return { connector: getOwned(db, ownerKey, id), secret };
}

export function listConnectors(db: Db, ownerKey: string): Connector[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM connectors WHERE owner_hash = ? ORDER BY created_at`)
    .all(hashSecret(ownerKey)) as unknown as Row[];
  return rows.map(fromRow);
}

/** One of this owner's connectors. Someone else's looks exactly like a missing one. */
export function getOwned(db: Db, ownerKey: string, id: string): Connector {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM connectors WHERE id = ? AND owner_hash = ?`)
    .get(id, hashSecret(ownerKey)) as Row | undefined;
  if (!row) throw notFound();
  return fromRow(row);
}

/** A new link; the old one stops working at once. */
export function rotateConnector(db: Db, ownerKey: string, id: string): { connector: Connector; secret: string } {
  getOwned(db, ownerKey, id);
  const secret = newSecret();
  db.prepare("UPDATE connectors SET secret_hash = ?, rotated_at = ? WHERE id = ?").run(
    hashSecret(secret),
    Date.now(),
    id,
  );
  return { connector: getOwned(db, ownerKey, id), secret };
}

export function deleteConnector(db: Db, ownerKey: string, id: string): void {
  const { changes } = db.prepare("DELETE FROM connectors WHERE id = ? AND owner_hash = ?").run(id, hashSecret(ownerKey));
  if (changes !== 1) throw notFound();
}

/** The connector a link belongs to (what the MCP endpoint resolves), if any. */
export function findConnectorBySecret(db: Db, secret: string): Connector | undefined {
  if (!secret) return undefined;
  const row = db.prepare(`SELECT ${COLUMNS} FROM connectors WHERE secret_hash = ?`).get(hashSecret(secret)) as
    | Row
    | undefined;
  return row ? fromRow(row) : undefined;
}

/** Note that the link was used (shown to its owner); at most one write a minute. */
export function touchConnector(db: Db, connector: Connector, now = Date.now()): void {
  if (connector.lastUsedAt !== null && now - connector.lastUsedAt < 60_000) return;
  db.prepare("UPDATE connectors SET last_used_at = ? WHERE id = ?").run(now, connector.id);
}
