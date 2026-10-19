import { beforeEach, describe, expect, it } from "vitest";
import { allow, resetRateLimitsForTests } from "./rate-limit";

beforeEach(resetRateLimitsForTests);

describe("allow", () => {
  it("lets `limit` requests through per window, per key", () => {
    expect([1, 2, 3].map(() => allow("a", 2, 1000, 0))).toEqual([true, true, false]);
    expect(allow("b", 2, 1000, 0)).toBe(true);
    expect(allow("a", 2, 1000, 999)).toBe(false);
    expect(allow("a", 2, 1000, 1000)).toBe(true);
  });

  it("never forgets a live count when full: it drops finished windows, or refuses new keys", () => {
    for (let i = 0; i < 10_000; i++) allow(`flood${i}`, 1, 60_000, 0);
    // "flood0" is used up; a flood of new keys can't reset it.
    expect(allow("flood0", 1, 60_000, 1)).toBe(false);
    expect(allow("newcomer", 5, 60_000, 1)).toBe(false);
    // Once those windows are over, there's room again.
    expect(allow("newcomer", 5, 60_000, 60_000)).toBe(true);
  });
});
