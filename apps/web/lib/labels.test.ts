import { describe, expect, it } from "vitest";
import { isAgent, participantLabel } from "./labels";

describe("participantLabel", () => {
  it("labels agents with a robot and their owner", () => {
    expect(participantLabel({ name: "Atlas", attributes: { kind: "agent", owner_name: "Kainoa" } })).toBe(
      "🤖 Kainoa's Atlas",
    );
  });

  it("labels an agent without an owner name as just an agent", () => {
    expect(participantLabel({ name: "Atlas", attributes: { kind: "agent" } })).toBe("🤖 Atlas");
  });

  it("uses the plain name for humans", () => {
    expect(participantLabel({ name: "Zach", attributes: { kind: "human" } })).toBe("Zach");
  });

  it("falls back to Guest when a human has no name", () => {
    expect(participantLabel({ name: undefined, attributes: {} })).toBe("Guest");
  });
});

describe("isAgent", () => {
  it("is true only for kind=agent", () => {
    expect(isAgent({ attributes: { kind: "agent" } })).toBe(true);
    expect(isAgent({ attributes: { kind: "human" } })).toBe(false);
    expect(isAgent({ attributes: {} })).toBe(false);
  });
});
