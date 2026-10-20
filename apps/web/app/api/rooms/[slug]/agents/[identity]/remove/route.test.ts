import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimAgentCode, createAgentCode, decideAgentRequest, getClaimStatus } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { floorView, requestTurn, resetFloorsForTests } from "@/lib/floor";
import { addParticipant, createRoom, getRoom } from "@/lib/rooms";
import { params, useTestEnv } from "@/test/helpers";

const removeFromRoom = vi.fn<(room: string, identity: string) => Promise<void>>(async () => {});
vi.mock("@/lib/livekit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/livekit")>()),
  removeFromRoom: (room: string, identity: string) => removeFromRoom(room, identity),
  setRoomMetadata: async () => {},
}));

const { POST } = await import("./route");

beforeEach(() => {
  useTestEnv();
  resetFloorsForTests();
  removeFromRoom.mockClear();
});

function approvedAgent() {
  const db = getDb();
  const { slug, hostSecret } = createRoom(db);
  const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
  const claim = claimAgentCode(db, { code: createAgentCode(db, zach).code, name: "Grok" });
  decideAgentRequest(db, { slug, requestId: claim.requestId, approve: true });
  const status = getClaimStatus(db, claim.requestId, claim.claimSecret);
  if (status.status !== "approved") throw new Error("setup failed");
  return { db, slug, hostSecret, zach, claim, identity: status.agent.identity };
}

const call = (slug: string, identity: string, cookie: string) =>
  POST(
    new Request(`http://localhost/api/rooms/${slug}/agents/${identity}/remove`, {
      method: "POST",
      headers: { cookie },
    }),
    params({ slug, identity }),
  );

describe("POST /api/rooms/[slug]/agents/[identity]/remove", () => {
  it("revokes the agent and disconnects it from LiveKit", async () => {
    const { db, slug, hostSecret, claim, identity } = approvedAgent();

    const res = await call(slug, identity, `mooz_host_${slug}=${hostSecret}`);

    expect(res.status).toBe(200);
    expect(removeFromRoom).toHaveBeenCalledWith(getRoom(db, slug)!.livekitRoom, identity);
    expect(getClaimStatus(db, claim.requestId, claim.claimSecret).status).toBe("revoked");
  });

  it("takes the agent's turn away", async () => {
    const { slug, hostSecret, identity } = approvedAgent();
    requestTurn(slug, identity, { answering: "person", speak: true });
    expect(floorView(slug).speaking).toBe(identity);
    await call(slug, identity, `mooz_host_${slug}=${hostSecret}`);
    expect(floorView(slug).speaking).toBeNull();
  });

  it("can be retried after LiveKit fails, without leaving the agent in the room", async () => {
    const { slug, hostSecret, identity } = approvedAgent();
    removeFromRoom.mockRejectedValueOnce(new Error("livekit unreachable"));

    expect((await call(slug, identity, `mooz_host_${slug}=${hostSecret}`)).status).toBe(500);
    expect((await call(slug, identity, `mooz_host_${slug}=${hostSecret}`)).status).toBe(200);
    expect(removeFromRoom).toHaveBeenCalledTimes(2);
  });

  it("is host-only", async () => {
    const { slug, zach, identity } = approvedAgent();

    const res = await call(slug, identity, `mooz_p_${slug}=${zach.secret}`);

    expect(res.status).toBe(403);
    expect(removeFromRoom).not.toHaveBeenCalled();
  });
});
