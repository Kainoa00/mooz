import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CONNECTORS_PER_OWNER,
  MAX_CONNECTORS,
  connectorUrl,
  createConnector,
  deleteConnector,
  findConnectorBySecret,
  touchConnector,
  listConnectors,
  rotateConnector,
} from "./connectors";
import { getDb } from "./db";
import { HttpError } from "./http";
import { AGENT_NAMES as NAMES, useTestEnv } from "@/test/helpers";

beforeEach(useTestEnv);

const KAI = "owner-key-kai";
const ZACH = "owner-key-zach";

describe("connectors", () => {
  it("are created for one owner, who alone sees them", () => {
    const db = getDb();
    const { connector, secret } = createConnector(db, KAI, { name: "Grok", app: "grok" });

    expect(connector).toMatchObject({ name: "Grok", app: "grok", lastUsedAt: null });
    expect(listConnectors(db, KAI)).toEqual([connector]);
    expect(listConnectors(db, ZACH)).toEqual([]);
    expect(findConnectorBySecret(db, secret)?.id).toBe(connector.id);
  });

  it("never store the secret or the owner's key, only their hashes", () => {
    const db = getDb();
    const { secret } = createConnector(db, KAI, { name: "Grok", app: "grok" });
    const row = JSON.stringify(db.prepare("SELECT * FROM connectors").all());
    expect(row).not.toContain(secret);
    expect(row).not.toContain(KAI);
  });

  it("stop working at the old link the moment they're rotated", () => {
    const db = getDb();
    const { connector, secret } = createConnector(db, KAI, { name: "Claude", app: "claude" });

    const rotated = rotateConnector(db, KAI, connector.id);

    expect(rotated.secret).not.toBe(secret);
    expect(findConnectorBySecret(db, secret)).toBeUndefined();
    expect(findConnectorBySecret(db, rotated.secret)?.id).toBe(connector.id);
    expect(rotated.connector.rotatedAt).not.toBeNull();
  });

  it("can be deleted, after which the link is dead", () => {
    const db = getDb();
    const { connector, secret } = createConnector(db, KAI, { name: "Grok", app: "grok" });
    deleteConnector(db, KAI, connector.id);
    expect(listConnectors(db, KAI)).toEqual([]);
    expect(findConnectorBySecret(db, secret)).toBeUndefined();
  });

  it("can't be rotated or deleted by anyone else, who can't tell they exist", () => {
    const db = getDb();
    const { connector, secret } = createConnector(db, KAI, { name: "Grok", app: "grok" });

    for (const attempt of [() => rotateConnector(db, ZACH, connector.id), () => deleteConnector(db, ZACH, connector.id)]) {
      expect(attempt).toThrow(HttpError);
      expect(attempt).toThrow("No such connector");
    }
    expect(() => deleteConnector(db, KAI, "c_doesnotexist0000")).toThrow("No such connector");
    expect(findConnectorBySecret(db, secret)?.id).toBe(connector.id);
  });

  it("follow the agent naming rules and know their app", () => {
    const db = getDb();
    expect(() => createConnector(db, KAI, { name: "x", app: "grok" })).toThrow(HttpError);
    expect(() => createConnector(db, KAI, { name: "Everyone", app: "grok" })).toThrow("too common");
    expect(() => createConnector(db, KAI, { name: "Grok", app: "gemini" })).toThrow("Pick Grok, Claude, ChatGPT or Other");
    expect(() => createConnector(db, KAI, { name: "Grok", app: 3 })).toThrow(HttpError);
  });

  it("keep one name per owner", () => {
    const db = getDb();
    createConnector(db, KAI, { name: "Grok", app: "grok" });
    expect(() => createConnector(db, KAI, { name: "grok", app: "other" })).toThrow("You already have a connector called");
    expect(() => createConnector(db, ZACH, { name: "Grok", app: "grok" })).not.toThrow();
  });

  it("are limited per owner", () => {
    const db = getDb();
    for (let i = 0; i < MAX_CONNECTORS_PER_OWNER; i++) {
      createConnector(db, KAI, { name: `Agent ${NAMES[i]}`, app: "other" });
    }
    expect(() => createConnector(db, KAI, { name: "Agent Zeta", app: "other" })).toThrow("at most");
  });

  it("ignore an empty or unknown secret", () => {
    const db = getDb();
    createConnector(db, KAI, { name: "Grok", app: "grok" });
    expect(findConnectorBySecret(db, "")).toBeUndefined();
    expect(findConnectorBySecret(db, "nope")).toBeUndefined();
  });

  it("note when they were last used", () => {
    const db = getDb();
    const { secret } = createConnector(db, KAI, { name: "Grok", app: "grok" });
    const found = findConnectorBySecret(db, secret)!;
    expect(found.lastUsedAt).toBeNull();
    touchConnector(db, found, 1_000_000);
    expect(listConnectors(db, KAI)[0].lastUsedAt).toBe(1_000_000);
    // At most one write a minute.
    touchConnector(db, findConnectorBySecret(db, secret)!, 1_030_000);
    expect(listConnectors(db, KAI)[0].lastUsedAt).toBe(1_000_000);
    touchConnector(db, findConnectorBySecret(db, secret)!, 1_061_000);
    expect(listConnectors(db, KAI)[0].lastUsedAt).toBe(1_061_000);
  });

  it("have a URL under /mcp", () => {
    expect(connectorUrl("https://meet.example.org", "abc")).toBe("https://meet.example.org/mcp/abc");
  });

  it("stop at what the server can keep", () => {
    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO connectors (id, owner_hash, name, app, secret_hash, created_at) VALUES (?, ?, 'G', 'grok', ?, ?)",
    );
    db.exec("BEGIN");
    for (let i = 0; i < MAX_CONNECTORS; i++) insert.run(`c${i}`, `o${i}`, `s${i}`, Date.now());
    db.exec("COMMIT");
    expect(() => createConnector(db, KAI, { name: "Grok", app: "grok" })).toThrow("can't keep any more");
  });

});
