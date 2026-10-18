import { TokenVerifier } from "livekit-server-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createRoom, findParticipant } from "@/lib/rooms";
import { LK_KEY, LK_SECRET, jsonRequest, params, setCookies, useTestEnv } from "@/test/helpers";
import { POST } from "./route";

beforeEach(useTestEnv);

const url = (slug: string) => `http://localhost:3000/api/rooms/${slug}/join`;

describe("POST /api/rooms/[slug]/join", () => {
  it("issues a LiveKit token and a participant cookie", async () => {
    const { slug } = createRoom(getDb());

    const res = await POST(jsonRequest(url(slug), { name: "  Zach  " }), params({ slug }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; url: string; identity: string; isHost: boolean };
    expect(body.url).toBe("ws://livekit.test:7880");
    expect(body.isHost).toBe(false);

    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(body.token);
    expect(claims.sub).toBe(body.identity);
    expect(claims.name).toBe("Zach");
    expect(claims.video?.room).toBe(slug);

    const secret = setCookies(res)[`mooz_p_${slug}`];
    expect(findParticipant(getDb(), slug, secret)?.identity).toBe(body.identity);
  });

  it("recognizes the host by their host cookie", async () => {
    const { slug, hostSecret } = createRoom(getDb());

    const res = await POST(
      jsonRequest(url(slug), { name: "Kainoa" }, { cookie: `mooz_host_${slug}=${hostSecret}` }),
      params({ slug }),
    );

    expect(((await res.json()) as { isHost: boolean }).isHost).toBe(true);
  });

  it("returns 404 for an unknown room", async () => {
    const res = await POST(jsonRequest(url("nope-nope-nop"), { name: "Zach" }), params({ slug: "nope-nope-nop" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "room_not_found" } });
  });

  it.each([[""], ["   "], [42], ["x".repeat(41)]])("rejects display name %j", async (name) => {
    const { slug } = createRoom(getDb());

    const res = await POST(jsonRequest(url(slug), { name }), params({ slug }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_name" } });
  });
});
