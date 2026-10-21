import { createHash } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimAgentCode, createAgentCode, decideAgentRequest, getClaimStatus, revokeAgent } from "@/lib/agents";
import { LEFT_GRACE_MS, attachedConnectorAgent, connectorAgentFor, connectorJoinStatus, requestConnectorJoin } from "@/lib/connector-agents";
import { enqueueQuestion, listQuestions, resetQueueForTests } from "@/lib/connector-queue";
import { createConnector } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { floorView, requestTurn, resetFloorsForTests } from "@/lib/floor";
import { setNotesPolicy } from "@/lib/notes";
import { addParticipant, createRoom, getRoom, getRoomByLivekitName } from "@/lib/rooms";
import { webhookArrives } from "@/lib/webhook-seen";
import { LK_KEY, LK_SECRET, useTestEnv } from "@/test/helpers";

const removeFromRoom = vi.fn<(room: string, identity: string) => Promise<void>>(async () => {});
const setRoomMetadata = vi.fn<(room: string, metadata: string) => Promise<void>>(async () => {});
vi.mock("@/lib/livekit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/livekit")>()),
  removeFromRoom: (room: string, identity: string) => removeFromRoom(room, identity),
  setRoomMetadata: (room: string, metadata: string) => setRoomMetadata(room, metadata),
}));

const { POST } = await import("./route");

beforeEach(() => {
  useTestEnv();
  resetQueueForTests();
  resetFloorsForTests();
  removeFromRoom.mockClear();
  setRoomMetadata.mockClear();
});

async function signed(body: string, secret = LK_SECRET): Promise<Request> {
  const at = new AccessToken(LK_KEY, secret);
  at.sha256 = createHash("sha256").update(body).digest("base64");
  return new Request("http://localhost/api/livekit/webhook", {
    method: "POST",
    headers: { authorization: await at.toJwt(), "content-type": "application/webhook+json" },
    body,
  });
}

function agent(revoked: boolean) {
  const db = getDb();
  const { slug } = createRoom(db);
  const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
  const claim = claimAgentCode(db, { code: createAgentCode(db, zach).code, name: "Grok" });
  decideAgentRequest(db, { slug, requestId: claim.requestId, approve: true });
  const status = getClaimStatus(db, claim.requestId, claim.claimSecret);
  if (status.status !== "approved") throw new Error("setup failed");
  if (revoked) revokeAgent(db, { slug, agentIdentity: status.agent.identity });
  return status.agent;
}

const joined = (room: string, identity: string) =>
  JSON.stringify({ event: "participant_joined", room: { name: room }, participant: { identity } });

describe("POST /api/livekit/webhook", () => {
  it("kicks a removed agent that rejoins", async () => {
    const a = agent(true);

    const res = await POST(await signed(joined(a.livekitRoom, a.identity)));

    expect(res.status).toBe(200);
    expect(removeFromRoom).toHaveBeenCalledWith(a.livekitRoom, a.identity);
  });

  it("leaves approved agents and humans alone", async () => {
    const a = agent(false);

    await POST(await signed(joined(a.livekitRoom, a.identity)));
    await POST(await signed(joined(a.livekitRoom, "p_someone")));

    expect(removeFromRoom).not.toHaveBeenCalled();
  });

  it("takes out a person who comes back on their old token under a name an agent took meanwhile", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const { livekitRoom } = getRoom(db, slug)!;
    const maya = addParticipant(db, { slug, name: "Maya", isHost: false });
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    // Maya came in and left; minutes later her name is free, and an agent takes it.
    db.prepare("UPDATE participants SET session_sid = 'PA_1', left_at = ? WHERE identity = ?").run(Date.now() - 3 * 60_000, maya.identity);
    const claim = claimAgentCode(db, { code: createAgentCode(db, zach).code, name: "Maya" });
    decideAgentRequest(db, { slug, requestId: claim.requestId, approve: true });

    await POST(await signed(joined(livekitRoom, zach.identity)));
    expect(removeFromRoom).not.toHaveBeenCalled();
    await POST(await signed(joined(livekitRoom, maya.identity)));
    expect(removeFromRoom).toHaveBeenCalledWith(livekitRoom, maya.identity);
  });

  it("rejects an unsigned or forged webhook", async () => {
    const a = agent(true);
    const body = joined(a.livekitRoom, a.identity);

    const unsigned = await POST(new Request("http://localhost/api/livekit/webhook", { method: "POST", body }));
    const forged = await POST(await signed(body, "not-the-secret-not-the-secret-000"));

    expect(unsigned.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(removeFromRoom).not.toHaveBeenCalled();
    // Nor does either count as the webhook reaching this server.
    expect(webhookArrives(getDb())).toBe(false);
    await POST(await signed(JSON.stringify({ event: "room_started", room: { name: "lk_none" } })));
    expect(webhookArrives(getDb())).toBe(true);
  });

  it("restores the notes policy when LiveKit starts the room again", async () => {
    const db = getDb();
    const allowed = createRoom(db);
    const notAllowed = createRoom(db);
    setNotesPolicy(db, allowed.slug, true);
    const started = (room: string) => JSON.stringify({ event: "room_started", room: { name: room } });

    await POST(await signed(started(getRoom(db, allowed.slug)!.livekitRoom)));
    await POST(await signed(started(getRoom(db, notAllowed.slug)!.livekitRoom)));
    await POST(await signed(started("lk_unknown")));

    expect(setRoomMetadata.mock.calls.map(([room, doc]) => [room, JSON.parse(doc)])).toEqual([
      [getRoom(db, allowed.slug)!.livekitRoom, { notes_allowed: true, floor: { speaking: null, next: null, paused: false, continued: 0 } }],
    ]);
  });

  it("lets a connector agent's tab step out for a couple of minutes, then takes it out with its questions", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
    const { connector } = createConnector(db, "kai-key", { name: "Grok", app: "grok" });
    const { requestId } = requestConnectorJoin(db, kai, "kai-key", connector.id);
    decideAgentRequest(db, { slug, requestId, approve: true });
    const grok = connectorAgentFor(db, kai, "kai-key", requestId);
    enqueueQuestion(db, grok, { asker: kai.identity, text: "q", lines: [] });
    const event = (name: string, sid: string) =>
      JSON.stringify({ event: name, room: { name: grok.livekitRoom }, participant: { identity: grok.identity, sid } });

    // A reload: the old session leaves after the new one joined. That late "left" changes nothing.
    await POST(await signed(event("participant_joined", "PA_one")));
    await POST(await signed(event("participant_joined", "PA_two")));
    await POST(await signed(event("participant_left", "PA_one")));
    const later = Date.now() + LEFT_GRACE_MS + 1;
    expect(attachedConnectorAgent(db, connector.id, later)?.identity).toBe(grok.identity);
    expect(removeFromRoom).not.toHaveBeenCalled();

    // Gone for a moment: still reachable, questions kept.
    await POST(await signed(event("participant_left", "PA_two")));
    expect(attachedConnectorAgent(db, connector.id)?.identity).toBe(grok.identity);
    expect(listQuestions(grok.identity)).toHaveLength(1);
    expect(connectorJoinStatus(db, kai, "kai-key", requestId)).toBe("approved");

    // Gone too long: out, and its questions with it.
    const tooLate = Date.now() + LEFT_GRACE_MS + 1000;
    expect(attachedConnectorAgent(db, connector.id, tooLate)).toBeUndefined();
    expect(listQuestions(grok.identity)).toEqual([]);
    expect(connectorJoinStatus(db, kai, "kai-key", requestId, tooLate)).toBe("revoked");
    expect(() => connectorAgentFor(db, kai, "kai-key", requestId, tooLate)).toThrow("not approved");
  });

  it("forgets who was in a meeting when it ends, and keeps the room and connectors (settings)", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    createAgentCode(db, zach);
    const bridge = agent(false);
    const { connector } = createConnector(db, "kai-key", { name: "Grok", app: "grok" });
    const { requestId } = requestConnectorJoin(db, kai, "kai-key", connector.id);
    decideAgentRequest(db, { slug, requestId, approve: true });
    const grok = connectorAgentFor(db, kai, "kai-key", requestId);
    enqueueQuestion(db, grok, { asker: kai.identity, text: "q", lines: [] });
    const rows = (s: string) =>
      ["participants", "agent_codes", "agent_requests"].map(
        (t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE room_slug = ?`).get(s) as { n: number }).n,
      );
    expect(rows(slug)).toEqual([2, 1, 1]);

    await POST(await signed(JSON.stringify({ event: "room_finished", room: { name: grok.livekitRoom } })));
    await POST(await signed(JSON.stringify({ event: "room_finished", room: { name: "lk_unknown" } })));

    expect(rows(slug)).toEqual([0, 0, 0]);
    expect(getRoom(db, slug)).toBeDefined();
    expect(db.prepare("SELECT 1 FROM connectors WHERE id = ?").get(connector.id)).toBeDefined();
    expect(attachedConnectorAgent(db, connector.id)).toBeUndefined();
    expect(listQuestions(grok.identity)).toEqual([]);
    // Another meeting is untouched (its used code goes in a sweep).
    expect(rows(bridge.slug)).toEqual([1, 1, 1]);

    // Its connector agent, back with a token it still holds, is shown out; a person isn't.
    await POST(await signed(joined(grok.livekitRoom, grok.identity)));
    await POST(await signed(joined(grok.livekitRoom, kai.identity)));
    expect(removeFromRoom.mock.calls).toEqual([[grok.livekitRoom, grok.identity]]);
  });

  it("kicks a connector agent that comes back after the grace period", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
    const { connector } = createConnector(db, "kai-key", { name: "Grok", app: "grok" });
    const { requestId } = requestConnectorJoin(db, kai, "kai-key", connector.id);
    decideAgentRequest(db, { slug, requestId, approve: true });
    const grok = connectorAgentFor(db, kai, "kai-key", requestId);
    const event = (name: string) =>
      JSON.stringify({ event: name, room: { name: grok.livekitRoom }, participant: { identity: grok.identity, sid: "PA_1" } });
    await POST(await signed(event("participant_joined")));
    await POST(await signed(event("participant_left")));
    db.prepare("UPDATE agent_requests SET left_at = ? WHERE id = ?").run(Date.now() - LEFT_GRACE_MS - 1000, requestId);

    await POST(await signed(event("participant_joined")));

    expect(removeFromRoom).toHaveBeenCalledWith(grok.livekitRoom, grok.identity);
    expect(connectorJoinStatus(db, kai, "kai-key", requestId)).toBe("revoked");
  });

  it("frees the floor when an agent leaves, and forgets a meeting's floor when it ends", async () => {
    const a = agent(false);
    const db = getDb();
    const meeting = getRoomByLivekitName(db, a.livekitRoom)!;
    requestTurn(meeting.slug, a.identity, { answering: "person", speak: true });
    requestTurn(meeting.slug, "agent-other", { answering: "person", speak: true });
    const ev = (event: string, sid: string) =>
      JSON.stringify({ event, room: { name: a.livekitRoom }, participant: { identity: a.identity, sid } });

    await POST(await signed(ev("participant_joined", "PA_1")));
    await POST(await signed(ev("participant_joined", "PA_2"))); // reconnected
    await POST(await signed(ev("participant_left", "PA_1"))); // the old connection, late
    expect(floorView(meeting.slug).speaking).toBe(a.identity);
    expect(db.prepare("SELECT left_at FROM agent_requests WHERE agent_identity = ?").get(a.identity)).toEqual({ left_at: null });
    await POST(await signed(ev("participant_left", "PA_2")));
    expect(floorView(meeting.slug).speaking).toBe("agent-other");
    expect(db.prepare("SELECT left_at FROM agent_requests WHERE agent_identity = ?").get(a.identity)).toEqual({
      left_at: expect.any(Number),
    });
    await POST(await signed(ev("participant_joined", "PA_3")));
    expect(db.prepare("SELECT left_at FROM agent_requests WHERE agent_identity = ?").get(a.identity)).toEqual({ left_at: null });

    await POST(await signed(JSON.stringify({ event: "room_finished", room: { name: a.livekitRoom } })));
    expect(floorView(meeting.slug).speaking).toBeNull();
  });

  it("frees the floor when a connector agent's tab leaves, but not for a late 'left' from an old connection", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
    const { connector } = createConnector(db, "kai-key", { name: "Grok", app: "grok" });
    const { requestId } = requestConnectorJoin(db, kai, "kai-key", connector.id);
    decideAgentRequest(db, { slug, requestId, approve: true });
    const grok = connectorAgentFor(db, kai, "kai-key", requestId);
    const ev = (event: string, sid: string) =>
      JSON.stringify({ event, room: { name: grok.livekitRoom }, participant: { identity: grok.identity, sid } });
    await POST(await signed(ev("participant_joined", "PA_1")));
    await POST(await signed(ev("participant_joined", "PA_2"))); // the tab reconnected
    requestTurn(slug, grok.identity, { answering: "person", speak: true });
    requestTurn(slug, "agent-other", { answering: "person", speak: true });

    await POST(await signed(ev("participant_left", "PA_1"))); // the old connection, late
    expect(floorView(slug).speaking).toBe(grok.identity);
    await POST(await signed(ev("participant_left", "PA_2")));
    expect(floorView(slug).speaking).toBe("agent-other");
  });

  it("refuses an oversized body before checking it", async () => {
    const res = await POST(
      new Request("http://localhost/api/livekit/webhook", { method: "POST", body: "x".repeat(70 * 1024) }),
    );
    expect(res.status).toBe(413);
  });
});
