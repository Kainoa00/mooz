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
