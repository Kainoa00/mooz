import { beforeEach, describe, expect, it } from "vitest";
import { allow, pruneExpiredWindows, resetRateLimitsForTests } from "./rate-limit";

beforeEach(resetRateLimitsForTests);

describe("allow", () => {
  it("lets `limit` requests through per window, per key", () => {
    expect([1, 2, 3].map(() => allow("a", 2, 1000, 0))).toEqual([true, true, false]);
    expect(allow("b", 2, 1000, 0)).toBe(true);
    expect(allow("a", 2, 1000, 999)).toBe(false);
    expect(allow("a", 2, 1000, 1000)).toBe(true);
  });

  it("when full, makes room by dropping finished windows, then the oldest, so a flood can't lock newcomers out", () => {
    expect(allow("mcp:oldest", 1, 60_000, 0)).toBe(true);
    for (let i = 0; i < 20_000; i++) allow(`mcp:flood${i}`, 1, 60_000, 1);
    // A newcomer still gets in; the oldest window made room (and starts over).
    expect(allow("mcp:newcomer", 5, 60_000, 2)).toBe(true);
    expect(allow("mcp:oldest", 1, 60_000, 2)).toBe(true);
    // A key whose window restarts moves to the back, so it isn't the next to go.
    expect(allow("mcp:flood1", 1, 60_000, 60_001)).toBe(true);
    expect(allow("mcp:newcomer2", 1, 60_000, 60_002)).toBe(true);
    expect(allow("mcp:flood1", 1, 60_000, 60_003)).toBe(false);
    // Other purposes have their own room: a server-wide ceiling is never pushed out by others.
    expect(allow("questions:a_1", 1, 60_000, 1)).toBe(true);
    expect(allow("questions:a_1", 1, 60_000, 2)).toBe(false);
  });

  it("forgets windows that are over", () => {
    allow("joins:abc", 1, 60_000, 0);
    allow("agent-codes:p_1", 1, 3_600_000, 0);
    pruneExpiredWindows(60_000);
    expect(allow("joins:abc", 1, 60_000, 60_000)).toBe(true);
    expect(allow("agent-codes:p_1", 1, 3_600_000, 60_000)).toBe(false); // still in its hour
  });
});
