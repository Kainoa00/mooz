import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "./db";
import { addParticipant, createRoom, findParticipant, getRoom, isHost } from "./rooms";
import { useTestEnv } from "@/test/helpers";

beforeEach(useTestEnv);

describe("createRoom", () => {
  it("stores the room and returns a host secret that proves host status", () => {
    const db = getDb();
    const { slug, hostSecret } = createRoom(db);

    expect(getRoom(db, slug)).toMatchObject({ slug });
    expect(isHost(db, slug, hostSecret)).toBe(true);
  });

  it("does not store the host secret in plain text", () => {
    const db = getDb();
    const { slug, hostSecret } = createRoom(db);

    const row = db.prepare("SELECT * FROM rooms WHERE slug = ?").get(slug);
    expect(JSON.stringify(row)).not.toContain(hostSecret);
  });
});

describe("isHost", () => {
  it("rejects a wrong or missing secret", () => {
    const db = getDb();
    const { slug } = createRoom(db);

    expect(isHost(db, slug, "wrong")).toBe(false);
    expect(isHost(db, slug, undefined)).toBe(false);
  });

  it("rejects another room's host secret", () => {
    const db = getDb();
    const a = createRoom(db);
    const b = createRoom(db);

    expect(isHost(db, b.slug, a.hostSecret)).toBe(false);
  });
});

describe("getRoom", () => {
  it("returns undefined for an unknown slug", () => {
    expect(getRoom(getDb(), "nope-nope-nop")).toBeUndefined();
  });
});

describe("participants", () => {
  it("adds a participant and finds them again by secret", () => {
    const db = getDb();
    const { slug } = createRoom(db);

    const p = addParticipant(db, { slug, name: "Kainoa", isHost: true });

    expect(p.identity).toMatch(/^p_/);
    expect(findParticipant(db, slug, p.secret)).toMatchObject({
      identity: p.identity,
      name: "Kainoa",
      isHost: true,
    });
  });

  it("does not find a participant with a wrong secret or in another room", () => {
    const db = getDb();
    const a = createRoom(db);
    const b = createRoom(db);
    const p = addParticipant(db, { slug: a.slug, name: "Zach", isHost: false });

    expect(findParticipant(db, a.slug, "wrong")).toBeUndefined();
    expect(findParticipant(db, b.slug, p.secret)).toBeUndefined();
    expect(findParticipant(db, a.slug, undefined)).toBeUndefined();
  });
});
