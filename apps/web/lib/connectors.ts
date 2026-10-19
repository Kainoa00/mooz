import { readCookie } from "./cookies";
import type { Db } from "./db";
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
export const OWNER_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
export const MAX_CONNECTORS_PER_OWNER = 10;

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
export function requireOwnerKey(req: Request): string {
  const owner = readCookie(req, OWNER_COOKIE);
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
export function findConnectorBySecret(db: Db, secret: string, opts: { touch?: boolean } = {}): Connector | undefined {
  if (!secret) return undefined;
  const row = db.prepare(`SELECT ${COLUMNS} FROM connectors WHERE secret_hash = ?`).get(hashSecret(secret)) as
    | Row
    | undefined;
  if (!row) return undefined;
  if (opts.touch) {
    const now = Date.now();
    db.prepare("UPDATE connectors SET last_used_at = ? WHERE id = ?").run(now, row.id);
    row.last_used_at = now;
  }
  return fromRow(row);
}
