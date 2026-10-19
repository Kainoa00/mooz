import { describe, expect, it } from "vitest";
import { parseAgentName, parseDisplayName } from "./names";

describe("parseDisplayName", () => {
  it("collapses whitespace", () => {
    expect(parseDisplayName("  Kainoa   K  ")).toBe("Kainoa K");
  });


  it.each(["Mehr\u200Cdad", "Kai \u{1F469}\u200D\u{1F4BB}"])("keeps joiners real names need: %j", (name) => {
    expect(parseDisplayName(name)).toBe(name);
  });

  it.each(["Ka\u200Binoa", "\u202Eanioak", "\u2066Kai\u2069"])("rejects invisible or bidi tricks: %j", (name) => {
    expect(() => parseDisplayName(name)).toThrowError(expect.objectContaining({ code: "invalid_name" }));
  });
});

describe("parseAgentName", () => {
  it("accepts a distinct name and trims it", () => {
    expect(parseAgentName("  Atlas ", [])).toBe("Atlas");
  });

  it.each(["Zach's Grok", "R2-D2", "Nova 2"])("accepts %j", (name) => {
    expect(parseAgentName(name, [])).toBe(name);
  });

  it.each([
    ["mooz", "reserved_name"],
    ["Mooz", "reserved_name"],
    ["everyone", "reserved_name"],
    ["Agents", "reserved_name"],
    ["hey", "reserved_name"],
    ["okay", "reserved_name"],
    ["A", "invalid_agent_name"],
    ["x".repeat(25), "invalid_agent_name"],
    ["2pac", "invalid_agent_name"],
    ["<script>", "invalid_agent_name"],
    ["", "invalid_agent_name"],
  ])("rejects %j with %s", (name, code) => {
    expect(() => parseAgentName(name, [])).toThrowError(expect.objectContaining({ status: 400, code }));
  });

  it("rejects a non-string", () => {
    expect(() => parseAgentName(7, [])).toThrowError(expect.objectContaining({ code: "invalid_agent_name" }));
  });

  it("rejects names already taken in the meeting, ignoring case", () => {
    expect(() => parseAgentName("atlas", ["Atlas"])).toThrowError(
      expect.objectContaining({ status: 409, code: "name_taken" }),
    );
  });

  it("rejects an agent named after a person in the meeting", () => {
    expect(() => parseAgentName("Zach", ["Kainoa", "zach"])).toThrowError(
      expect.objectContaining({ code: "name_taken" }),
    );
  });
});

describe("hidden text in names", () => {
  it("refuses Unicode tags, private use and smuggling selectors, but not emoji or joiners", () => {
    for (const hidden of [
      "Zach" + String.fromCodePoint(0xe0068, 0xe0069),
      "Zach\ue000",
      "Zach\u00ad",
      "Zach\ufe00",
      "Zach" + String.fromCodePoint(0xe0100),
      "Zach\u206a",
      "\u0600Zach",
      "Zach\u200d\u200d\u200d",
    ]) {
      expect(() => parseDisplayName(hidden)).toThrow("invisible");
    }
    expect(parseDisplayName("Zach ❤️")).toBe("Zach ❤️");
    expect(parseDisplayName("👩\u200d💻 Lee")).toBe("👩\u200d💻 Lee");
  });
});
