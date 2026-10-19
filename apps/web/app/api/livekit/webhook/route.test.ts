import { createHash } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimAgentCode, createAgentCode, decideAgentRequest, getClaimStatus, revokeAgent } from "@/lib/agents";
import { LEFT_GRACE_MS, attachedConnectorAgent, connectorAgentFor, connectorJoinStatus, requestConnectorJoin } from "@/lib/connector-agents";
import { enqueueQuestion, listQuestions, resetQueueForTests } from "@/lib/connector-queue";
import { createConnector } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { setNotesPolicy } from "@/lib/notes";
import { addParticipant, createRoom, getRoom } from "@/lib/rooms";
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

  it("rejects an unsigned or forged webhook", async () => {
    const a = agent(true);
    const body = joined(a.livekitRoom, a.identity);

    const unsigned = await POST(new Request("http://localhost/api/livekit/webhook", { method: "POST", body }));
    const forged = await POST(await signed(body, "not-the-secret-not-the-secret-000"));

    expect(unsigned.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(removeFromRoom).not.toHaveBeenCalled();
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

    expect(setRoomMetadata.mock.calls).toEqual([[getRoom(db, allowed.slug)!.livekitRoom, '{"notes_allowed":true}']]);
  });

  it("takes a connector agent out while its tab is gone, and lets it back within a couple of minutes", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
    const { connector } = createConnector(db, "kai-key", { name: "Grok", app: "grok" });
    const { requestId } = requestConnectorJoin(db, kai, "kai-key", connector.id);
    decideAgentRequest(db, { slug, requestId, approve: true });
    const grok = connectorAgentFor(db, kai, "kai-key", requestId);
    enqueueQuestion(db, grok, { asker: kai.identity, text: "q", lines: [] });
    const event = (name: string) =>
      JSON.stringify({ event: name, room: { name: grok.livekitRoom }, participant: { identity: grok.identity } });

    await POST(await signed(event("participant_left")));
    expect(attachedConnectorAgent(db, connector.id)).toBeUndefined(); // its assistant can't reach the meeting
    expect(listQuestions(grok.identity)).toEqual([]);
    expect(connectorJoinStatus(db, kai, "kai-key", requestId)).toBe("approved"); // a reload may come back

    await POST(await signed(event("participant_joined")));
    expect(attachedConnectorAgent(db, connector.id)?.identity).toBe(grok.identity);
    expect(removeFromRoom).not.toHaveBeenCalled();

    await POST(await signed(event("participant_left")));
    const later = Date.now() + LEFT_GRACE_MS + 1;
    expect(connectorJoinStatus(db, kai, "kai-key", requestId, later)).toBe("revoked");
    expect(() => connectorAgentFor(db, kai, "kai-key", requestId, later)).toThrow("not approved");
  });

  it("ends a meeting's connector agents when the meeting ends", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
    const { connector } = createConnector(db, "kai-key", { name: "Grok", app: "grok" });
    const { requestId } = requestConnectorJoin(db, kai, "kai-key", connector.id);
    decideAgentRequest(db, { slug, requestId, approve: true });
    const grok = connectorAgentFor(db, kai, "kai-key", requestId);
    enqueueQuestion(db, grok, { asker: kai.identity, text: "q", lines: [] });

    await POST(await signed(JSON.stringify({ event: "room_finished", room: { name: grok.livekitRoom } })));
    await POST(await signed(JSON.stringify({ event: "room_finished", room: { name: "lk_unknown" } })));

    expect(connectorJoinStatus(db, kai, "kai-key", requestId)).toBe("revoked");
    expect(attachedConnectorAgent(db, connector.id)).toBeUndefined();
    expect(listQuestions(grok.identity)).toEqual([]);
  });
});
