import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "./db";
import { getNotesOptOut, getNotesPolicy, setNotesOptOut, setNotesPolicy } from "./notes";
import { addParticipant, createRoom } from "./rooms";
import { useTestEnv } from "@/test/helpers";

beforeEach(useTestEnv);

describe("meeting notes consent", () => {
  it("is off until the host allows it, per meeting", () => {
    const db = getDb();
    const a = createRoom(db);
    const b = createRoom(db);
    expect(getNotesPolicy(db, a.slug)).toBe(false);

    setNotesPolicy(db, a.slug, true);

    expect(getNotesPolicy(db, a.slug)).toBe(true);
    expect(getNotesPolicy(db, b.slug)).toBe(false);
    setNotesPolicy(db, a.slug, false);
    expect(getNotesPolicy(db, a.slug)).toBe(false);
  });

  it("remembers each person's opt-out", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    const kai = addParticipant(db, { slug, name: "Kai", isHost: true });

    setNotesOptOut(db, zach.identity, true);

    expect(getNotesOptOut(db, zach.identity)).toBe(true);
    expect(getNotesOptOut(db, kai.identity)).toBe(false);
    setNotesOptOut(db, zach.identity, false);
    expect(getNotesOptOut(db, zach.identity)).toBe(false);
  });
});
