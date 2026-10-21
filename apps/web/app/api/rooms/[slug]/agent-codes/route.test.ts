import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { addParticipant, createRoom, notePersonPresence } from "@/lib/rooms";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { params, useTestEnv } from "@/test/helpers";
import { CODES_PER_MEETING_PER_HOUR, CODES_PER_PERSON_PER_HOUR, POST } from "./route";

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

  it("gives one meeting only so many an hour, however many times people join", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const ask = (secret: string) =>
      POST(
        new Request(`https://mooz.example/api/rooms/${slug}/agent-codes`, { method: "POST", headers: { cookie: `mooz_p_${slug}=${secret}` } }),
        params({ slug }),
      );
    const statuses: number[] = [];
    for (let person = 0; person < 6; person++) {
      const p = addParticipant(db, { slug, name: `Person ${person}`, isHost: false });
      for (let i = 0; i < CODES_PER_PERSON_PER_HOUR; i++) statuses.push((await ask(p.secret)).status);
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(CODES_PER_MEETING_PER_HOUR);
    expect(statuses.at(-1)).toBe(429);
    // That doesn't stop the host, or anyone LiveKit has seen come into the call.
    const host = addParticipant(db, { slug, name: "Kainoa", isHost: true });
    expect((await ask(host.secret)).status).toBe(201);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    expect((await ask(zach.secret)).status).toBe(429);
    notePersonPresence(db, zach.identity, "PA_zach", true);
    expect((await ask(zach.secret)).status).toBe(201);
    // Another meeting is unaffected.
    const other = createRoom(db).slug;
    const lee = addParticipant(db, { slug: other, name: "Lee", isHost: false });
    const res = await POST(
      new Request(`https://mooz.example/api/rooms/${other}/agent-codes`, { method: "POST", headers: { cookie: `mooz_p_${other}=${lee.secret}` } }),
      params({ slug: other }),
    );
    expect(res.status).toBe(201);
  });
});
