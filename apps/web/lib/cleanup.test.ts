import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentCode,
  createAgentCode,
  decideAgentRequest,
  MAX_UNSEEN_NAMES,
  markTokenIssued,
  meetingsTooBusyForTests,
  namesForNewAgent,
  noteBridgePresence,
  requireBridgeAgent,
} from "./agents";
import { ROOM_IDLE_MS, SWEEP_EVERY_MS, endMeeting, maybeSweep, sweep } from "./cleanup";
import { getDb, openDb, type Db } from "./db";
import {
  SESSION_TTL_MS,
  addParticipant,
  createRoom,
  findParticipant,
  getRoom,
  isHost,
  renameParticipant,
  touchRoom,
  type Participant,
} from "./rooms";
import { namesInMemoryForTests, parseAgentName } from "./names";
import { noteRoomWebhook } from "./webhook-seen";
import { useTestEnv } from "@/test/helpers";

const T0 = new Date("2026-10-21T12:00:00Z").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
  useTestEnv();
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

const at = (t: number) => vi.setSystemTime(t);

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** An agent brought by `owner`, approved, with its token handed out and in the meeting. */
function bridgeAgent(db: Db, owner: Participant, name = "Grok") {
  const claim = claimAgentCode(db, { code: createAgentCode(db, owner).code, name });
  decideAgentRequest(db, { slug: owner.slug, requestId: claim.requestId, approve: true });
  markTokenIssued(db, claim.requestId);
  const row = db.prepare("SELECT agent_identity FROM agent_requests WHERE id = ?").get(claim.requestId) as {
    agent_identity: string;
  };
  noteBridgePresence(db, row.agent_identity, "PA_1", true);
  return { ...claim, identity: row.agent_identity };
}

describe("sessions expire", () => {
  it("lets a participant's secret work for a day after their last join", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    expect(findParticipant(db, slug, zach.secret, T0 + SESSION_TTL_MS - 1)?.identity).toBe(zach.identity);
    expect(findParticipant(db, slug, zach.secret, T0 + SESSION_TTL_MS)).toBeUndefined();

    // Coming back (a rejoin) gives it another day.
    renameParticipant(db, zach, "Zach", false, T0 + 20 * HOUR);
    expect(findParticipant(db, slug, zach.secret, T0 + 20 * HOUR + SESSION_TTL_MS - 1)).toBeDefined();
    expect(findParticipant(db, slug, zach.secret, T0 + 20 * HOUR + SESSION_TTL_MS)).toBeUndefined();
  });

  it("lets the host's secret work for a day after their last join", () => {
    const db = getDb();
    const { slug, hostSecret } = createRoom(db);
    expect(isHost(db, slug, hostSecret, T0 + SESSION_TTL_MS - 1)).toBe(true);
    expect(isHost(db, slug, hostSecret, T0 + SESSION_TTL_MS)).toBe(false);

    touchRoom(db, slug, false, T0 + 20 * HOUR); // a guest joining doesn't extend the host
    expect(isHost(db, slug, hostSecret, T0 + SESSION_TTL_MS)).toBe(false);
    touchRoom(db, slug, true, T0 + 20 * HOUR);
    expect(isHost(db, slug, hostSecret, T0 + 20 * HOUR + SESSION_TTL_MS - 1)).toBe(true);
  });

  it("stops a bridge's calls when its owner's session ends, or a day after its token", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    const grok = bridgeAgent(db, zach);
    expect(requireBridgeAgent(db, grok.requestId, grok.claimSecret).identity).toBe(grok.identity);

    at(T0 + SESSION_TTL_MS);
    expect(() => requireBridgeAgent(db, grok.requestId, grok.claimSecret)).toThrow(/run out/);

    // Zach came back in time, but the token is a day old.
    renameParticipant(db, zach, "Zach", false, T0 + 23 * HOUR);
    expect(() => requireBridgeAgent(db, grok.requestId, grok.claimSecret)).toThrow(/run out/);
    at(T0 + SESSION_TTL_MS - 1);
    expect(requireBridgeAgent(db, grok.requestId, grok.claimSecret).identity).toBe(grok.identity);
  });
});

/** Fills a meeting with joins nobody can vouch for, and finds it too busy to check names. */
function makeTooBusy(db: Db, slug: string) {
  const insert = db.prepare(
    "INSERT INTO participants (identity, room_slug, name, is_host, secret_hash, created_at, expires_at) VALUES (?, ?, ?, 0, 's', ?, ?)",
  );
  db.exec("BEGIN");
  for (let i = 0; i <= MAX_UNSEEN_NAMES; i++) insert.run(`p_${slug}_${i}`, slug, `Ghost ${i}`, Date.now(), Date.now() + SESSION_TTL_MS);
  db.exec("COMMIT");
  expect(() => namesForNewAgent(db, slug)).toThrow("too busy");
  expect(meetingsTooBusyForTests()).toContain(slug);
}

describe("endMeeting", () => {
  it("deletes a meeting's people, codes and requests in an order the foreign keys allow, and keeps the room", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const other = createRoom(db).slug;
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    bridgeAgent(db, zach); // a used code and a request
    createAgentCode(db, zach);
    const lee = addParticipant(db, { slug: other, name: "Lee", isHost: false });
    bridgeAgent(db, lee, "Atlas");

    expect(endMeeting(db, slug)).toBe(4); // 2 codes, 1 request, 1 person
    expect(getRoom(db, slug)).toBeDefined();
    expect([count(db, "participants"), count(db, "agent_codes"), count(db, "agent_requests")]).toEqual([1, 1, 1]);
    expect(endMeeting(db, slug)).toBe(0);
  });

  it("forgets the names worked out for name checks", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    parseAgentName("Atlas", ["Zach", "Mia"]);
    expect(namesInMemoryForTests()).toBeGreaterThan(0);
    endMeeting(db, slug);
    expect(namesInMemoryForTests()).toBe(0);
  });

  it("forgets that the meeting was too busy to check agents' names", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    makeTooBusy(db, slug);
    endMeeting(db, slug);
    expect(meetingsTooBusyForTests()).not.toContain(slug);
  });

  it("forgets when the webhook last spoke of the meeting", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    noteRoomWebhook(db, getRoom(db, slug)!.livekitRoom);
    const heard = () => (db.prepare("SELECT webhook_at FROM rooms WHERE slug = ?").get(slug) as { webhook_at: number | null }).webhook_at;
    expect(heard()).not.toBeNull();
    endMeeting(db, slug);
    expect(heard()).toBeNull();
  });
});

describe("sweep", () => {
  it("forgets the names worked out for name checks when it removes anyone", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    addParticipant(db, { slug, name: "Zach", isHost: false });
    parseAgentName("Atlas", ["Zach"]);
    expect(sweep(db)).toBe(0);
    expect(namesInMemoryForTests()).toBeGreaterThan(0); // nothing went, so nothing to forget
    expect(sweep(db, Date.now() + SESSION_TTL_MS + 1)).toBeGreaterThan(0);
    expect(namesInMemoryForTests()).toBe(0);
  });

  it("forgets meetings found too busy to check names once that has run out, though nothing else went", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    makeTooBusy(db, slug);
    expect(sweep(db)).toBe(0);
    expect(meetingsTooBusyForTests()).toContain(slug); // not yet: claims are still refused without looking
    expect(sweep(db, Date.now() + 11_000)).toBe(0);
    expect(meetingsTooBusyForTests()).not.toContain(slug);
  });

  it("forgets when the webhook last spoke of a meeting nobody is left in, though LiveKit never said it ended", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    addParticipant(db, { slug, name: "Zach", isHost: false });
    noteRoomWebhook(db, getRoom(db, slug)!.livekitRoom);
    const heard = () => (db.prepare("SELECT webhook_at FROM rooms WHERE slug = ?").get(slug) as { webhook_at: number | null }).webhook_at;
    sweep(db);
    expect(heard()).not.toBeNull(); // Zach is still here
    sweep(db, Date.now() + SESSION_TTL_MS + 1);
    expect(heard()).toBeNull();
  });

  it("deletes codes once they've expired", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    const { expiresAt } = createAgentCode(db, zach);
    expect(sweep(db, expiresAt - 1)).toBe(0);
    expect(sweep(db, expiresAt)).toBe(1);
    expect(count(db, "agent_codes")).toBe(0);
  });

  it("keeps an approved agent that's still in the meeting, while its owner's session lasts", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    const grok = bridgeAgent(db, zach);
    const kept = () => db.prepare("SELECT 1 FROM agent_requests WHERE id = ?").get(grok.requestId) !== undefined;

    // A day and more in, Zach keeps coming back: his agent stays.
    renameParticipant(db, zach, "Zach", false, T0 + 20 * HOUR);
    sweep(db, T0 + 30 * HOUR);
    expect(kept()).toBe(true);

    // Once it has left, a day-old request goes.
    noteBridgePresence(db, grok.identity, "PA_1", false);
    sweep(db, T0 + 30 * HOUR);
    expect(kept()).toBe(false);
    expect(count(db, "participants")).toBe(1);
  });

  it("deletes requests that never got in, a day after they were made", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    claimAgentCode(db, { code: createAgentCode(db, zach).code, name: "Grok" }); // pending, never decided
    renameParticipant(db, zach, "Zach", false, T0 + 23 * HOUR);
    sweep(db, T0 + DAY - 1);
    expect(count(db, "agent_requests")).toBe(1);
    sweep(db, T0 + DAY);
    expect(count(db, "agent_requests")).toBe(0);
  });

  it("deletes people whose session ended, with their codes and their agents' requests", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    bridgeAgent(db, zach);
    const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true }, T0 + 10 * HOUR);

    expect(sweep(db, T0 + SESSION_TTL_MS)).toBe(3); // Zach, his used code and his agent's request
    expect(findParticipant(db, slug, kai.secret, T0 + SESSION_TTL_MS)?.identity).toBe(kai.identity);
    expect([count(db, "participants"), count(db, "agent_codes"), count(db, "agent_requests")]).toEqual([1, 0, 0]);
  });

  it("deletes a room 30 days after its last join, with everything in it", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const busy = createRoom(db).slug;
    addParticipant(db, { slug, name: "Zach", isHost: false }, T0 + ROOM_IDLE_MS); // a row the sweep would keep alone
    touchRoom(db, busy, false, T0 + 10 * DAY);

    sweep(db, T0 + ROOM_IDLE_MS - 1);
    expect(getRoom(db, slug)).toBeDefined();
    sweep(db, T0 + ROOM_IDLE_MS);
    expect(getRoom(db, slug)).toBeUndefined();
    expect(count(db, "participants")).toBe(0);
    expect(getRoom(db, busy)).toBeDefined();
  });

  it("runs at most once a minute", () => {
    const db = getDb();
    expect(maybeSweep(db, T0)).toBe(0);
    expect(maybeSweep(db, T0 + SWEEP_EVERY_MS - 1)).toBeNull();
    expect(maybeSweep(db, T0 + SWEEP_EVERY_MS)).toBe(0);
    // A clock that went back doesn't stop it for good.
    expect(maybeSweep(db, T0)).toBe(0);
  });
});

describe("on disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mooz-cleanup-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("overwrites deleted rows and empties the write-ahead log after deleting", () => {
    const file = path.join(dir, "mooz.db");
    const db = openDb(file);
    expect(db.prepare("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
    const { slug } = createRoom(db);
    for (let i = 0; i < 20; i++) addParticipant(db, { slug, name: `Person ${i}`, isHost: false });
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);

    expect(endMeeting(db, slug)).toBe(20);
    expect(statSync(`${file}-wal`).size).toBe(0);
    db.close();
  });
});
