/** A fixed-window request counter per key, in this process's memory. */

const STORE = Symbol.for("mooz.rateLimits");
const MAX_KEYS = 10_000;

interface Window {
  start: number;
  count: number;
}

function windows(): Map<string, Window> {
  const g = globalThis as unknown as Record<symbol, Map<string, Window> | undefined>;
  return (g[STORE] ??= new Map());
}

/** Whether one more request under `key` fits in `limit` per `windowMs`; counts it if so. */
export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const all = windows();
  let w = all.get(key);
  if (!w || now - w.start >= windowMs) {
    if (!w && all.size >= MAX_KEYS) all.clear(); // a flood of keys: start over rather than grow
    w = { start: now, count: 0 };
    all.set(key, w);
  }
  if (w.count >= limit) return false;
  w.count += 1;
  return true;
}

export function resetRateLimitsForTests(): void {
  windows().clear();
}
