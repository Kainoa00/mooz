import { TokenVerifier } from "livekit-server-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { claimAgentCode, createAgentCode } from "@/lib/agents";
import { setNotesOptOut } from "@/lib/notes";
import { ROOM_IDLE_MS } from "@/lib/cleanup";
import { SESSION_TTL_MS, addParticipant, createRoom, findParticipant, isHost } from "@/lib/rooms";
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
    expect(claims.video?.room).toMatch(/^lk_/);
    expect(claims.video?.room).not.toBe(slug);

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

  it.each([[""], ["   "], [42], ["x".repeat(41)], ["🤖 Kainoa's Notetaker"], ["Ka\u200Binoa"], ["\u202Eanioak"]])("rejects display name %j", async (name) => {
    const { slug } = createRoom(getDb());

    const res = await POST(jsonRequest(url(slug), { name }), params({ slug }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_name" } });
  });

  it("refuses a human name that matches an agent's wake name", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
    claimAgentCode(db, { code: createAgentCode(db, kai).code, name: "Atlas" });

    const res = await POST(jsonRequest(url(slug), { name: "atlas" }), params({ slug }));
    expect(res.status).toBe(409);

    const alike = await POST(jsonRequest(url(slug), { name: "Atlis Smith" }), params({ slug }));
    expect(alike.status).toBe(409);
    expect((await alike.json()).error.message).toMatch(/sounds like the name of an agent/);
  });

  it.each([
    [{ "sec-fetch-site": "same-site" }],
    [{ "sec-fetch-site": "cross-site" }],
    [{ origin: "https://evil.example" }],
  ])("rejects cross-site requests (%j)", async (headers) => {
    const { slug } = createRoom(getDb());

    const res = await POST(jsonRequest(url(slug), { name: "Zach" }, headers), params({ slug }));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "cross_site" } });
  });

  it("accepts a same-origin browser request", async () => {
    const { slug } = createRoom(getDb());

    const res = await POST(
      jsonRequest(url(slug), { name: "Zach" }, { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" }),
      params({ slug }),
    );

    expect(res.status).toBe(200);
  });

  describe("rejoining after a reload", () => {
    async function joinOnce(slug: string, body: Record<string, unknown>, cookie = "") {
      const res = await POST(jsonRequest(url(slug), body, cookie ? { cookie } : {}), params({ slug }));
      const json = (await res.json()) as { identity: string; isHost: boolean; token: string };
      return { res, json, secret: setCookies(res)[`mooz_p_${slug}`] };
    }

    it("keeps the same identity so the agent still knows its owner", async () => {
      const { slug } = createRoom(getDb());
      const first = await joinOnce(slug, { name: "Zach" });

      const again = await joinOnce(slug, { name: "Zach B", rejoin: first.json.identity }, `mooz_p_${slug}=${first.secret}`);

      expect(again.json.identity).toBe(first.json.identity);
      expect(again.secret).toBe(first.secret);
      expect(findParticipant(getDb(), slug, first.secret)?.name).toBe("Zach B");
    });

    it("gives a second tab its own identity unless it asks to rejoin", async () => {
      const { slug } = createRoom(getDb());
      const first = await joinOnce(slug, { name: "Zach" });

      const secondTab = await joinOnce(slug, { name: "Zach" }, `mooz_p_${slug}=${first.secret}`);

      expect(secondTab.json.identity).not.toBe(first.json.identity);
    });

    it("ignores another meeting's cookie", async () => {
      const db = getDb();
      const a = createRoom(db);
      const b = createRoom(db);
      const first = await joinOnce(a.slug, { name: "Zach" });

      const other = await joinOnce(b.slug, { name: "Zach", rejoin: first.json.identity }, `mooz_p_${a.slug}=${first.secret}`);

      expect(other.json.identity).not.toBe(first.json.identity);
    });

    it("keeps host status on rejoin", async () => {
      const { slug, hostSecret } = createRoom(getDb());
      const host = `mooz_host_${slug}=${hostSecret}`;
      const first = await joinOnce(slug, { name: "Kai" }, host);

      const again = await joinOnce(slug, { name: "Kai", rejoin: first.json.identity }, `${host}; mooz_p_${slug}=${first.secret}`);

      expect(again.json).toMatchObject({ identity: first.json.identity, isHost: true });
    });

    it("never takes over another tab's identity", async () => {
      const { slug } = createRoom(getDb());
      const tabA = await joinOnce(slug, { name: "Zach" });
      // Tab B in the same browser joins; the shared cookie now belongs to B.
      const tabB = await joinOnce(slug, { name: "Zach" }, `mooz_p_${slug}=${tabA.secret}`);

      const reloadA = await joinOnce(slug, { name: "Zach", rejoin: tabA.json.identity }, `mooz_p_${slug}=${tabB.secret}`);

      expect(reloadA.json.identity).not.toBe(tabB.json.identity);
    });

    it("keeps a notes opt-out on rejoin", async () => {
      const { slug } = createRoom(getDb());
      const first = await joinOnce(slug, { name: "Zach" });
      setNotesOptOut(getDb(), first.json.identity, true);

      const again = await joinOnce(slug, { name: "Zach", rejoin: first.json.identity }, `mooz_p_${slug}=${first.secret}`);

      const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(again.json.token);
      expect(claims.attributes).toEqual({ kind: "human", notes_opt_out: "1" });
    });
  });

  describe("over time", () => {
    const T0 = new Date("2026-10-21T12:00:00Z").getTime();
    beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
    afterEach(() => vi.useRealTimers());

    it("gives the host another day with each join, and their cookie with it", async () => {
      const db = getDb();
      const { slug, hostSecret } = createRoom(db);
      vi.setSystemTime(T0 + 20 * 60 * 60 * 1000);

      const res = await POST(jsonRequest(url(slug), { name: "Kainoa" }, { cookie: `mooz_host_${slug}=${hostSecret}` }), params({ slug }));

      expect(((await res.json()) as { isHost: boolean }).isHost).toBe(true);
      expect(setCookies(res)[`mooz_host_${slug}`]).toBe(hostSecret);
      expect(isHost(db, slug, hostSecret, T0 + SESSION_TTL_MS + 1)).toBe(true);
    });

    it("joins as someone new once a session has run out", async () => {
      const { slug } = createRoom(getDb());
      const first = await POST(jsonRequest(url(slug), { name: "Zach" }), params({ slug }));
      const { identity } = (await first.json()) as { identity: string };
      const secret = setCookies(first)[`mooz_p_${slug}`];
      vi.setSystemTime(T0 + SESSION_TTL_MS);

      const again = await POST(
        jsonRequest(url(slug), { name: "Zach", rejoin: identity }, { cookie: `mooz_p_${slug}=${secret}` }),
        params({ slug }),
      );
      expect(((await again.json()) as { identity: string }).identity).not.toBe(identity);
    });

    it("finds a meeting nobody joined for 30 days gone", async () => {
      const { slug } = createRoom(getDb());
      vi.setSystemTime(T0 + ROOM_IDLE_MS);
      const res = await POST(jsonRequest(url(slug), { name: "Zach" }), params({ slug }));
      expect(res.status).toBe(404);
    });
  });
});
