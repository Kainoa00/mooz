import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { addParticipant, createRoom } from "@/lib/rooms";
import { params, useTestEnv } from "@/test/helpers";
import { POST } from "./route";

beforeEach(useTestEnv);

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
