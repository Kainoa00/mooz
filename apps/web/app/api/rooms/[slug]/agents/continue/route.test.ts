import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { MAX_AGENT_STREAK, endTurn, floorView, requestTurn, resetFloorsForTests } from "@/lib/floor";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { addParticipant, createRoom } from "@/lib/rooms";
import { jsonRequest, params, useTestEnv } from "@/test/helpers";

vi.mock("@/lib/livekit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/livekit")>()),
  setRoomMetadata: async () => {},
}));

const { CONTINUES_PER_MINUTE, POST } = await import("./route");

beforeEach(() => {
  useTestEnv();
  resetFloorsForTests();
  resetRateLimitsForTests();
});

function paused() {
  const db = getDb();
  const { slug } = createRoom(db);
  const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
  for (let i = 0; i < MAX_AGENT_STREAK; i++) {
    const agent = i % 2 ? "agent-atlas" : "agent-nova";
    endTurn(slug, agent, requestTurn(slug, agent, { answering: "agent", speak: true }).id);
  }
  const held = requestTurn(slug, "agent-atlas", { answering: "agent", speak: true });
  return { slug, zach, held };
}

const call = (slug: string, headers: Record<string, string>) =>
  POST(jsonRequest(`http://localhost/api/rooms/${slug}/agents/continue`, {}, headers), params({ slug }));

describe("POST /api/rooms/[slug]/agents/continue", () => {
  it("lets anyone in the meeting release the held reply", async () => {
    const { slug, zach, held } = paused();
    expect(held.status).toBe("held");
    const res = await call(slug, { cookie: `mooz_p_${slug}=${zach.secret}` });
    expect(await res.json()).toEqual({ released: true });
    expect(floorView(slug)).toMatchObject({ speaking: "agent-atlas", paused: false });

    const again = await call(slug, { cookie: `mooz_p_${slug}=${zach.secret}` });
    expect(await again.json()).toEqual({ released: false });
  });

  it("is for people in the meeting, from this site", async () => {
    const { slug, zach } = paused();
    expect((await call(slug, {})).status).toBe(401);
    expect((await call(slug, { cookie: `mooz_p_${slug}=nope` })).status).toBe(401);
    expect((await call(slug, { cookie: `mooz_p_${slug}=${zach.secret}`, "sec-fetch-site": "cross-site" })).status).toBe(403);
    const form = await POST(
      new Request(`http://localhost/api/rooms/${slug}/agents/continue`, {
        method: "POST",
        headers: { cookie: `mooz_p_${slug}=${zach.secret}`, "content-type": "text/plain" },
        body: "{}",
      }),
      params({ slug }),
    );
    expect(form.status).toBe(415);
    expect(floorView(slug).paused).toBe(true);
  });

  it("is limited per person", async () => {
    const { slug, zach } = paused();
    const statuses: number[] = [];
    for (let i = 0; i <= CONTINUES_PER_MINUTE; i++) statuses.push((await call(slug, { cookie: `mooz_p_${slug}=${zach.secret}` })).status);
    expect(statuses.at(-1)).toBe(429);
  });
});
