import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { addParticipant, createRoom } from "@/lib/rooms";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { params, useTestEnv } from "@/test/helpers";
import { CODES_PER_PERSON_PER_HOUR, POST } from "./route";

beforeEach(() => {
  useTestEnv();
  resetRateLimitsForTests();
});

describe("POST /api/rooms/[slug]/agent-codes", () => {
  it("gives a joined participant a code and the command to run", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });

    const res = await POST(
      new Request(`https://mooz.example/api/rooms/${slug}/agent-codes`, {
        method: "POST",
        headers: { cookie: `mooz_p_${slug}=${zach.secret}` },
      }),
      params({ slug }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; command: string; expiresAt: number };
    expect(body.command).toBe(`mooz-agent connect ${body.code} --server https://mooz.example`);
  });

  it("gives one person only so many codes an hour (each can try a few names)", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    const statuses: number[] = [];
    for (let i = 0; i <= CODES_PER_PERSON_PER_HOUR; i++) {
      const res = await POST(
        new Request(`https://mooz.example/api/rooms/${slug}/agent-codes`, {
          method: "POST",
          headers: { cookie: `mooz_p_${slug}=${zach.secret}` },
        }),
        params({ slug }),
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, -1).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("refuses someone who has not joined the meeting", async () => {
    const { slug } = createRoom(getDb());

    const res = await POST(
      new Request(`http://localhost/api/rooms/${slug}/agent-codes`, { method: "POST" }),
      params({ slug }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "not_joined" } });
  });
});
