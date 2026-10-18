import { createHash } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimAgentCode, createAgentCode, decideAgentRequest, getClaimStatus, revokeAgent } from "@/lib/agents";
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
});
