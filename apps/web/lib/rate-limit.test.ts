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
    // The flood itself pushed mcp:oldest out, and a newcomer still gets in (flood0 makes room);
    // mcp:oldest starts over.
    expect(allow("mcp:newcomer", 5, 60_000, 2)).toBe(true);
    expect(allow("mcp:oldest", 1, 60_000, 2)).toBe(true);
    // Other purposes have their own room: a server-wide ceiling is never pushed out by others.
    expect(allow("questions:a_1", 1, 60_000, 1)).toBe(true);
    expect(allow("questions:a_1", 1, 60_000, 2)).toBe(false);
  });

  it("moves a key whose window starts over to the back, so it isn't the next to go", () => {
    expect(allow("mcp:a", 1, 10, 0)).toBe(true);
    for (let i = 0; i < 19_999; i++) allow(`mcp:flood${i}`, 1, 60_000, 1);
    expect(allow("mcp:a", 1, 10, 20)).toBe(true); // a new window, and now the newest
    expect(allow("mcp:newcomer", 1, 60_000, 21)).toBe(true); // full: the oldest (flood0) goes
    expect(allow("mcp:a", 1, 10, 22)).toBe(false); // still counted
    expect(allow("mcp:flood0", 1, 60_000, 23)).toBe(true); // forgotten, so it starts over
  });

  it("forgets windows that are over", () => {
    allow("joins:abc", 1, 60_000, 0);
    allow("agent-codes:p_1", 1, 3_600_000, 0);
    pruneExpiredWindows(60_000);
    const stores = (globalThis as unknown as Record<symbol, Map<string, Map<string, unknown>>>)[Symbol.for("mooz.rateLimits")];
    expect(stores.has("joins")).toBe(false);
    expect([...(stores.get("agent-codes")?.keys() ?? [])]).toEqual(["agent-codes:p_1"]); // still in its hour
    expect(allow("agent-codes:p_1", 1, 3_600_000, 60_000)).toBe(false);
  });
});
