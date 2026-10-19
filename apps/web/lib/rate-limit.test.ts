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
});
