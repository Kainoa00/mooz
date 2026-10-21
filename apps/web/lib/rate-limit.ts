/**
 * Fixed-window request counters, in this process's memory. Each purpose (the part of a key
 * before its first ":") has its own store, so a flood of one kind of key can't crowd out another.
 */

import { envInt } from "./env";

const STORE = Symbol.for("mooz.rateLimits");
// Room for every connector's MCP window twice over (the connector cap is configurable).
const MAX_KEYS = Math.max(20_000, 2 * envInt("MOOZ_MAX_CONNECTORS", 10_000));

interface Window {
  start: number;
  count: number;
  windowMs: number;
}

function stores(): Map<string, Map<string, Window>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Map<string, Window>> | undefined>;
  return (g[STORE] ??= new Map());
}

/** Whether one more request under `key` fits in `limit` per `windowMs`; counts it if so. */
export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const purpose = key.split(":", 1)[0];
  let all = stores().get(purpose);
  if (!all) stores().set(purpose, (all = new Map()));
  let w = all.get(key);
  if (!w || now - w.start >= windowMs) {
    if (!w && all.size >= MAX_KEYS) {
      // Full: drop windows that are over, then the oldest live one. Refusing new keys instead
      // would let a flood of throwaway keys (fresh identities) lock everyone else out, and the
      // ceilings that matter are single keys, which a flood of others never pushes out.
      prune(all, now);
      if (all.size >= MAX_KEYS) all.delete(all.keys().next().value as string);
    }
    // Kept in the order windows start, so the first key is always the oldest window.
    all.delete(key);
    w = { start: now, count: 0, windowMs };
    all.set(key, w);
  }
  if (w.count >= limit) return false;
  w.count += 1;
  return true;
}

function prune(all: Map<string, Window>, now: number): void {
  for (const [k, w] of all) if (now - w.start >= w.windowMs) all.delete(k);
}

/** Forget windows that are over (the sweep runs this, so counts don't outlast their use). */
export function pruneExpiredWindows(now = Date.now()): void {
  for (const [purpose, all] of stores()) {
    prune(all, now);
    if (all.size === 0) stores().delete(purpose);
  }
}

export function resetRateLimitsForTests(): void {
  stores().clear();
}
