import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { endTurn, requestTurn, resetFloorsForTests } from "@/lib/floor";
import { setNotesPolicy } from "@/lib/notes";
import { createRoom, getRoom } from "@/lib/rooms";
import { useTestEnv } from "@/test/helpers";

const setRoomMetadata = vi.fn<(room: string, metadata: string) => Promise<void>>(async () => {});
vi.mock("@/lib/livekit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/livekit")>()),
  setRoomMetadata: (room: string, metadata: string) => setRoomMetadata(room, metadata),
}));

const { PUBLISH_DELAY_MS, publishRoomState, resetRoomStateForTests, roomMetadata } = await import("./room-state");

beforeEach(() => {
  useTestEnv();
  resetFloorsForTests();
  resetRoomStateForTests();
  setRoomMetadata.mockReset();
  setRoomMetadata.mockImplementation(async () => {});
});
afterEach(() => {
  vi.useRealTimers();
});

const sent = () => setRoomMetadata.mock.calls.map(([room, doc]) => [room, JSON.parse(doc)]);

describe("room state", () => {
  it("is one document: the notes policy and who has the floor", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    setNotesPolicy(db, slug, true);
    requestTurn(slug, "agent-atlas", { answering: "person", speak: true });
    requestTurn(slug, "agent-nova", { answering: "person", speak: true });
    expect(JSON.parse(roomMetadata(db, slug))).toEqual({
      notes_allowed: true,
      floor: { speaking: "agent-atlas", next: "agent-nova", paused: false, continued: 0 },
    });
  });

  it("tells the meeting about floor changes, once for a burst of them", async () => {
    vi.useFakeTimers();
    const db = getDb();
    const { slug } = createRoom(db);
    const atlas = requestTurn(slug, "agent-atlas", { answering: "person", speak: true });
    requestTurn(slug, "agent-nova", { answering: "person", speak: true });
    endTurn(slug, "agent-atlas", atlas.id);
    expect(setRoomMetadata).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PUBLISH_DELAY_MS);
    expect(sent()).toEqual([
      [getRoom(db, slug)!.livekitRoom, { notes_allowed: false, floor: { speaking: "agent-nova", next: null, paused: false, continued: 0 } }],
    ]);
  });

  it("sends one update at a time, each with the state when it goes out", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    let release!: () => void;
    setRoomMetadata.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const first = publishRoomState(db, slug);
    await vi.waitFor(() => expect(setRoomMetadata).toHaveBeenCalledTimes(1)); // in flight
    setNotesPolicy(db, slug, true);
    const second = publishRoomState(db, slug);
    await new Promise((r) => setTimeout(r, 10));
    expect(setRoomMetadata).toHaveBeenCalledTimes(1); // waits for the first
    release();
    await Promise.all([first, second]);
    expect(sent().map(([, doc]) => doc.notes_allowed)).toEqual([false, true]);
  });

  it("keeps going after a failed update, and reports it to the caller", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    setRoomMetadata.mockRejectedValueOnce(new Error("LiveKit is down"));
    await expect(publishRoomState(db, slug)).rejects.toThrow("LiveKit is down");
    await publishRoomState(db, slug);
    expect(setRoomMetadata).toHaveBeenCalledTimes(2);
  });

  it("logs a failed floor update instead of throwing", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = getDb();
    const { slug } = createRoom(db);
    setRoomMetadata.mockRejectedValueOnce(new Error("LiveKit is down"));
    requestTurn(slug, "agent-atlas", { answering: "person", speak: true });
    await vi.advanceTimersByTimeAsync(PUBLISH_DELAY_MS);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("floor"), expect.any(Error));
    errors.mockRestore();
  });

  it("does nothing for a meeting that doesn't exist", async () => {
    await publishRoomState(getDb(), "no-such-room");
    expect(setRoomMetadata).not.toHaveBeenCalled();
  });
});
