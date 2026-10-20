import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { getNotesPolicy } from "@/lib/notes";
import { addParticipant, createRoom, getRoom } from "@/lib/rooms";
import { jsonRequest, params, useTestEnv } from "@/test/helpers";

const setRoomMetadata = vi.fn<(room: string, metadata: string) => Promise<void>>(async () => {});
vi.mock("@/lib/livekit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/livekit")>()),
  setRoomMetadata: (room: string, metadata: string) => setRoomMetadata(room, metadata),
}));

const { POST } = await import("./route");

beforeEach(() => {
  useTestEnv();
  setRoomMetadata.mockClear();
});

const call = (slug: string, body: unknown, headers: Record<string, string>) =>
  POST(jsonRequest(`http://localhost/api/rooms/${slug}/notes-policy`, body, headers), params({ slug }));

describe("POST /api/rooms/[slug]/notes-policy", () => {
  it("lets the host allow notes and tells LiveKit", async () => {
    const db = getDb();
    const { slug, hostSecret } = createRoom(db);

    const res = await call(slug, { allowed: true }, { cookie: `mooz_host_${slug}=${hostSecret}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true });
    expect(getNotesPolicy(db, slug)).toBe(true);
    const [[room, doc]] = setRoomMetadata.mock.calls;
    expect(room).toBe(getRoom(db, slug)!.livekitRoom);
    expect(JSON.parse(doc)).toMatchObject({ notes_allowed: true });
  });

  it("is host-only", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });

    const res = await call(slug, { allowed: true }, { cookie: `mooz_p_${slug}=${zach.secret}` });

    expect(res.status).toBe(403);
    expect(getNotesPolicy(db, slug)).toBe(false);
    expect(setRoomMetadata).not.toHaveBeenCalled();
  });

  it("refuses cross-site requests", async () => {
    const { slug, hostSecret } = createRoom(getDb());

    const res = await call(slug, { allowed: true }, {
      cookie: `mooz_host_${slug}=${hostSecret}`,
      "sec-fetch-site": "cross-site",
    });

    expect(res.status).toBe(403);
    expect(setRoomMetadata).not.toHaveBeenCalled();
  });

  it("needs a true or false", async () => {
    const { slug, hostSecret } = createRoom(getDb());

    const res = await call(slug, { allowed: "yes" }, { cookie: `mooz_host_${slug}=${hostSecret}` });

    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown meeting", async () => {
    expect((await call("abc-defg-hij", { allowed: true }, {})).status).toBe(404);
  });
});
