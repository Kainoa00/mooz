import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { getNotesOptOut } from "@/lib/notes";
import { addParticipant, createRoom, getRoom } from "@/lib/rooms";
import { jsonRequest, params, useTestEnv } from "@/test/helpers";

type Attrs = Record<string, string>;
const setParticipantAttributes = vi.fn<(room: string, identity: string, attrs: Attrs) => Promise<void>>(
  async () => {},
);
vi.mock("@/lib/livekit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/livekit")>()),
  setParticipantAttributes: (room: string, identity: string, attrs: Attrs) =>
    setParticipantAttributes(room, identity, attrs),
}));

const { POST } = await import("./route");

beforeEach(() => {
  useTestEnv();
  setParticipantAttributes.mockClear();
});

const call = (slug: string, body: unknown, headers: Record<string, string>) =>
  POST(jsonRequest(`http://localhost/api/rooms/${slug}/notes-opt-out`, body, headers), params({ slug }));

function meeting() {
  const db = getDb();
  const { slug } = createRoom(db);
  const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
  const kai = addParticipant(db, { slug, name: "Kai", isHost: true });
  return { db, slug, zach, kai, livekitRoom: getRoom(db, slug)!.livekitRoom };
}

describe("POST /api/rooms/[slug]/notes-opt-out", () => {
  it("leaves the caller out of notes and tells LiveKit", async () => {
    const { db, slug, zach, livekitRoom } = meeting();

    const res = await call(slug, { optOut: true, identity: zach.identity }, { cookie: `mooz_p_${slug}=${zach.secret}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ optOut: true });
    expect(getNotesOptOut(db, zach.identity)).toBe(true);
    expect(setParticipantAttributes).toHaveBeenCalledWith(livekitRoom, zach.identity, { notes_opt_out: "1" });
  });

  it("can be undone", async () => {
    const { db, slug, zach, livekitRoom } = meeting();
    const cookie = `mooz_p_${slug}=${zach.secret}`;
    await call(slug, { optOut: true, identity: zach.identity }, { cookie });

    await call(slug, { optOut: false, identity: zach.identity }, { cookie });

    expect(getNotesOptOut(db, zach.identity)).toBe(false);
    // An empty value removes the attribute in LiveKit.
    expect(setParticipantAttributes).toHaveBeenLastCalledWith(livekitRoom, zach.identity, { notes_opt_out: "" });
  });

  it("only ever changes the caller, and refuses when the tab isn't the cookie's participant", async () => {
    const { db, slug, zach, kai } = meeting();

    // Two tabs share one cookie: a tab whose identity no longer matches it gets an error,
    // instead of silently opting out someone else.
    const res = await call(slug, { optOut: true, identity: kai.identity }, { cookie: `mooz_p_${slug}=${zach.secret}` });

    expect(res.status).toBe(409);
    expect(getNotesOptOut(db, kai.identity)).toBe(false);
    expect(getNotesOptOut(db, zach.identity)).toBe(false);
    expect(setParticipantAttributes).not.toHaveBeenCalled();
  });

  it("needs a joined participant and a same-origin request", async () => {
    const { slug, zach } = meeting();

    const anonymous = await call(slug, { optOut: true, identity: zach.identity }, {});
    const crossSite = await call(slug, { optOut: true, identity: zach.identity }, {
      cookie: `mooz_p_${slug}=${zach.secret}`,
      "sec-fetch-site": "cross-site",
    });

    expect(anonymous.status).toBe(401);
    expect(crossSite.status).toBe(403);
    expect(setParticipantAttributes).not.toHaveBeenCalled();
  });

  it("needs a true or false", async () => {
    const { slug, zach } = meeting();

    const res = await call(slug, { optOut: 1, identity: zach.identity }, { cookie: `mooz_p_${slug}=${zach.secret}` });

    expect(res.status).toBe(400);
  });
});
