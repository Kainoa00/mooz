import { TokenVerifier } from "livekit-server-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentCode, decideAgentRequest } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { addParticipant, createRoom } from "@/lib/rooms";
import { LK_KEY, LK_SECRET, jsonRequest, params, useTestEnv } from "@/test/helpers";
import { POST } from "./route";
import { GET } from "./[id]/route";

beforeEach(useTestEnv);

function poll(id: string, secret?: string) {
  return GET(
    new Request(`http://localhost/api/agent/claim/${id}`, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }),
    params({ id }),
  );
}

describe("agent claim flow", () => {
  it("returns a scoped agent token only after the host approves", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    const { code } = createAgentCode(db, zach);

    const claimRes = await POST(jsonRequest("http://localhost/api/agent/claim", { code, name: "Grok" }));
    expect(claimRes.status).toBe(201);
    const claimed = (await claimRes.json()) as { requestId: string; claimSecret: string; status: string };
    const { requestId, claimSecret } = claimed;
    expect(claimed.status).toBe("pending");
    expect(JSON.stringify(claimed)).not.toContain(slug);

    const pending = await poll(requestId, claimSecret);
    expect(await pending.json()).toEqual({ status: "pending" });

    decideAgentRequest(db, { slug, requestId, approve: true });

    const approved = (await (await poll(requestId, claimSecret)).json()) as {
      status: string;
      token: string;
      url: string;
      room: string;
      identity: string;
    };
    expect(approved).toMatchObject({ status: "approved", url: "ws://livekit.test:7880" });
    expect(approved.room).not.toBe(slug);
    expect(approved.room).toMatch(/^lk_/);
    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(approved.token);
    expect(claims.sub).toBe(approved.identity);
    expect(claims.attributes?.kind).toBe("agent");
    expect(claims.attributes?.owner_name).toBe("Zach");
  });

  it("rejects a bad code", async () => {
    const res = await POST(jsonRequest("http://localhost/api/agent/claim", { code: "AAAA-AAAA-AAAA", name: "Grok" }));

    expect(res.status).toBe(400);
  });

  it("rejects polling without the claim secret", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    const claimRes = await POST(
      jsonRequest("http://localhost/api/agent/claim", { code: createAgentCode(db, zach).code, name: "Grok" }),
    );
    const { requestId } = (await claimRes.json()) as { requestId: string };

    expect((await poll(requestId)).status).toBe(404);
  });
});
