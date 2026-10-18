import { beforeEach, describe, expect, it } from "vitest";
import { claimAgentCode, createAgentCode, getClaimStatus } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { addParticipant, createRoom } from "@/lib/rooms";
import { jsonRequest, params, useTestEnv } from "@/test/helpers";
import { GET } from "./route";
import { POST } from "./[id]/route";

beforeEach(useTestEnv);

function setup() {
  const db = getDb();
  const { slug, hostSecret } = createRoom(db);
  const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
  const claim = claimAgentCode(db, { code: createAgentCode(db, zach).code, name: "Grok" });
  return { db, slug, hostSecret, zach, claim };
}

describe("GET /api/rooms/[slug]/agent-requests", () => {
  it("lists pending agents for the host", async () => {
    const { slug, hostSecret, claim } = setup();

    const res = await GET(
      new Request(`http://localhost/api/rooms/${slug}/agent-requests`, {
        headers: { cookie: `mooz_host_${slug}=${hostSecret}` },
      }),
      params({ slug }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      requests: [{ id: claim.requestId, agentName: "Grok", ownerName: "Zach", createdAt: expect.any(Number) }],
    });
  });

  it("is host-only", async () => {
    const { slug, zach } = setup();

    const res = await GET(
      new Request(`http://localhost/api/rooms/${slug}/agent-requests`, {
        headers: { cookie: `mooz_p_${slug}=${zach.secret}` },
      }),
      params({ slug }),
    );

    expect(res.status).toBe(403);
  });
});

describe("POST /api/rooms/[slug]/agent-requests/[id]", () => {
  it("lets the host approve", async () => {
    const { db, slug, hostSecret, claim } = setup();

    const res = await POST(
      jsonRequest(
        `http://localhost/api/rooms/${slug}/agent-requests/${claim.requestId}`,
        { decision: "approve" },
        { cookie: `mooz_host_${slug}=${hostSecret}` },
      ),
      params({ slug, id: claim.requestId }),
    );

    expect(res.status).toBe(200);
    expect(getClaimStatus(db, claim.requestId, claim.claimSecret).status).toBe("approved");
  });

  it("does not let a non-host approve", async () => {
    const { db, slug, zach, claim } = setup();

    const res = await POST(
      jsonRequest(
        `http://localhost/api/rooms/${slug}/agent-requests/${claim.requestId}`,
        { decision: "approve" },
        { cookie: `mooz_p_${slug}=${zach.secret}` },
      ),
      params({ slug, id: claim.requestId }),
    );

    expect(res.status).toBe(403);
    expect(getClaimStatus(db, claim.requestId, claim.claimSecret).status).toBe("pending");
  });

  it("rejects an unknown decision", async () => {
    const { slug, hostSecret, claim } = setup();

    const res = await POST(
      jsonRequest(
        `http://localhost/api/rooms/${slug}/agent-requests/${claim.requestId}`,
        { decision: "maybe" },
        { cookie: `mooz_host_${slug}=${hostSecret}` },
      ),
      params({ slug, id: claim.requestId }),
    );

    expect(res.status).toBe(400);
  });
});
