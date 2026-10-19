import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AddressDetector, phoneticKey, ratio, type Via } from "./addressing";

interface Case {
  name: string;
  via: Via;
  text: string;
  question: string | null;
}

// The same cases the bridge's detector runs (bridge/tests/test_addressing.py).
const { cases } = JSON.parse(
  readFileSync(new URL("../../../bridge/tests/addressing_cases.json", import.meta.url), "utf8"),
) as { cases: Case[] };

describe("AddressDetector (the bridge's cases)", () => {
  it("has the whole corpus", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it.each(cases.map((c) => [`${c.name} | ${c.via} | ${c.text}`, c] as const))("%s", (_, c) => {
    const result = new AddressDetector(c.name).check(c.text, c.via);
    expect(result ? result.question : null).toBe(c.question);
  });
});

describe("its building blocks", () => {
  it("groups spellings that sound alike", () => {
    expect(phoneticKey("Atlas")).toBe(phoneticKey("Atlis"));
    expect(phoneticKey("Atlas")).toBe(phoneticKey("Atlus"));
    expect(phoneticKey("Atlas")).not.toBe(phoneticKey("Alice"));
    expect(phoneticKey("123")).toBe("");
  });

  it("scores similarity like rapidfuzz's ratio", () => {
    expect(ratio("atlas", "atlas")).toBe(100);
    expect(ratio("", "")).toBe(100);
    expect(ratio("atlis", "atlas")).toBe(80);
    expect(ratio("abc", "xyz")).toBe(0);
    // Values from rapidfuzz.fuzz.ratio, which the bridge uses.
    for (const [a, b, expected] of [
      ["claud", "claude", 90.9090909090909],
      ["could", "claude", 54.54545454545454],
      ["grock", "grok", 88.88888888888889],
      ["outlast", "atlas", 66.66666666666667],
    ] as const) {
      expect(ratio(a, b)).toBeCloseTo(expected, 10);
    }
  });
});
