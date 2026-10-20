import { describe, expect, it } from "vitest";
import { NO_FLOOR, floorText, parseFloor } from "./floor-protocol";

describe("parseFloor", () => {
  it("reads the floor from the room metadata", () => {
    const metadata = JSON.stringify({ notes_allowed: true, floor: { speaking: "a_1", next: "a_2", paused: true } });
    expect(parseFloor(metadata)).toEqual({ speaking: "a_1", next: "a_2", paused: true });
  });

  it.each([undefined, "", "not json", "null", '{"notes_allowed":true}', '{"floor":"x"}'])("is quiet for %j", (metadata) => {
    expect(parseFloor(metadata)).toEqual(NO_FLOOR);
  });

  it("ignores values of the wrong kind", () => {
    expect(parseFloor('{"floor":{"speaking":7,"next":"","paused":"yes"}}')).toEqual(NO_FLOOR);
  });
});

describe("floorText", () => {
  const names: Record<string, string> = { a_1: "🤖 Kainoa's Atlas", a_2: "🤖 Zach's Nova" };
  const label = (identity: string) => names[identity];

  it("says who is speaking and who is next", () => {
    expect(floorText({ speaking: "a_1", next: "a_2", paused: false }, label)).toBe(
      "🤖 Kainoa's Atlas is speaking · next: 🤖 Zach's Nova",
    );
    expect(floorText({ speaking: "a_1", next: null, paused: false }, label)).toBe("🤖 Kainoa's Atlas is speaking");
    expect(floorText({ speaking: null, next: "a_2", paused: false }, label)).toBe("Next: 🤖 Zach's Nova");
  });

  it("says nothing when the floor is quiet, or about agents who aren't here", () => {
    expect(floorText(NO_FLOOR, label)).toBeNull();
    expect(floorText({ speaking: "a_gone", next: null, paused: false }, label)).toBeNull();
  });
});
