import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MY_REQUESTS_PER_MINUTE,
  claimAgentCode,
  createAgentCode,
  decideAgentRequest,
  getClaimStatus,
  listPendingRequests,
} from "@/lib/agents";
import { getDb } from "@/lib/db";
import { addParticipant, createRoom, type Participant } from "@/lib/rooms";
import { jsonRequest, params, useTestEnv } from "@/test/helpers";

const removeFromRoom = vi.fn<(room: string, identity: string) => Promise<void>>(async () => {});
vi.mock("@/lib/livekit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/livekit")>()),
  removeFromRoom: (room: string, identity: string) => removeFromRoom(room, identity),
  setRoomMetadata: async () => {},
}));

const { GET } = await import("./route");
const { POST: withdraw } = await import("./[id]/withdraw/route");

beforeEach(() => {
  useTestEnv();
  removeFromRoom.mockClear();
});

const cookie = (p: Participant & { secret: string }) => ({ cookie: `mooz_p_${p.slug}=${p.secret}` });

function mine(p: Participant & { secret: string }) {
  return GET(new Request(`http://localhost/api/rooms/${p.slug}/my-agent-requests`, { headers: cookie(p) }), params({ slug: p.slug }));
}

function cancel(p: Participant & { secret: string }, id: string, headers: Record<string, string> = {}, body: unknown = {}) {
  return withdraw(
    jsonRequest(`http://localhost/api/rooms/${p.slug}/my-agent-requests/${id}/withdraw`, body, { ...cookie(p), ...headers }),
    params({ slug: p.slug, id }),
  );
}

function setup() {
  const db = getDb();
  const { slug } = createRoom(db);
  const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
  const lee = addParticipant(db, { slug, name: "Lee", isHost: false });
  const bring = (owner: Participant, name: string) => claimAgentCode(db, { code: createAgentCode(db, owner).code, name });
  return { db, slug, zach, lee, bring };
}

describe("GET /api/rooms/[slug]/my-agent-requests", () => {
  it("lists the agents brought with my codes, waiting or in, and nobody else's", async () => {
    const { db, slug, zach, lee, bring } = setup();
    const atlas = bring(zach, "Atlas");
    const nova = bring(zach, "Nova");
    bring(lee, "Orion");
    decideAgentRequest(db, { slug, requestId: nova.requestId, approve: true });
    const denied = bring(zach, "Pixel");
    decideAgentRequest(db, { slug, requestId: denied.requestId, approve: false });

    const res = await mine(zach);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { requests } = (await res.json()) as { requests: { id: string; agentName: string; status: string }[] };
    expect(requests.map((r) => [r.id, r.agentName, r.status])).toEqual([
      [atlas.requestId, "Atlas", "pending"],
      [nova.requestId, "Nova", "approved"],
    ]);
  });

  it("needs me to be in the meeting", async () => {
    const { slug } = setup();
    const res = await GET(new Request(`http://localhost/api/rooms/${slug}/my-agent-requests`), params({ slug }));
    expect(res.status).toBe(401);
  });

  it("answers 60 times a minute per person", async () => {
    const { zach, lee } = setup();
    for (let i = 0; i < MY_REQUESTS_PER_MINUTE; i++) expect((await mine(zach)).status).toBe(200);
    expect((await mine(zach)).status).toBe(429);
    expect((await mine(lee)).status).toBe(200);
  });
});

describe("POST /api/rooms/[slug]/my-agent-requests/[id]/withdraw", () => {
  it("declines a request still waiting: the host's tray drops it and the bridge hears 'denied'", async () => {
    const { db, slug, zach, bring } = setup();
    const atlas = bring(zach, "Atlas");

    expect((await cancel(zach, atlas.requestId)).status).toBe(200);
    expect(listPendingRequests(db, slug)).toEqual([]);
    expect(getClaimStatus(db, atlas.requestId, atlas.claimSecret)).toEqual({ status: "denied" });
    expect(() => decideAgentRequest(db, { slug, requestId: atlas.requestId, approve: true })).toThrow(/already decided/);
    expect(removeFromRoom).not.toHaveBeenCalled();
    // Again: nothing more to do.
    expect((await cancel(zach, atlas.requestId)).status).toBe(200);
  });

  it("removes an agent that's already in, and can retry the removal", async () => {
    const { db, slug, zach, bring } = setup();
    const atlas = bring(zach, "Atlas");
    decideAgentRequest(db, { slug, requestId: atlas.requestId, approve: true });
    const status = getClaimStatus(db, atlas.requestId, atlas.claimSecret);
    if (status.status !== "approved") throw new Error("setup failed");

    expect((await cancel(zach, atlas.requestId)).status).toBe(200);
    expect(getClaimStatus(db, atlas.requestId, atlas.claimSecret)).toEqual({ status: "revoked" });
    expect(removeFromRoom).toHaveBeenCalledWith(status.agent.livekitRoom, status.agent.identity);
    expect((await cancel(zach, atlas.requestId)).status).toBe(200);
    expect(removeFromRoom).toHaveBeenCalledTimes(2);
  });

  it("can't touch someone else's request, and says no more than 'not found'", async () => {
    const { db, slug, zach, lee, bring } = setup();
    const orion = bring(lee, "Orion");
    const res = await cancel(zach, orion.requestId);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("request_not_found");
    expect(listPendingRequests(db, slug).map((r) => r.id)).toEqual([orion.requestId]);
    expect((await cancel(zach, "r_nope")).status).toBe(404);
  });

  it("refuses cross-site requests and plain form posts", async () => {
    const { db, slug, zach, bring } = setup();
    const atlas = bring(zach, "Atlas");
    expect((await cancel(zach, atlas.requestId, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const form = await withdraw(
      new Request(`http://localhost/api/rooms/${slug}/my-agent-requests/${atlas.requestId}/withdraw`, {
        method: "POST",
        headers: { ...cookie(zach), "content-type": "text/plain" },
        body: "{}",
      }),
      params({ slug, id: atlas.requestId }),
    );
    expect(form.status).toBe(415);
    expect(listPendingRequests(db, slug)).toHaveLength(1);
  });

  it("shares the per-person limit with checking", async () => {
    const { zach, bring } = setup();
    const atlas = bring(zach, "Atlas");
    for (let i = 0; i < MY_REQUESTS_PER_MINUTE; i++) await mine(zach);
    expect((await cancel(zach, atlas.requestId)).status).toBe(429);
  });
});
