import type { Answering } from "./floor";

/**
 * Taking turns from the owner's tab, for its connector agent (docs/protocol.md, "Taking
 * turns"): ask the meeting's floor before posting or speaking, wait until it's granted, and
 * give it back after. The same rules as the bridge's (bridge/src/mooz_agent/turns.py).
 */

export type { Answering };

/** A held reply waits for a person to click Continue; past this it isn't worth saying. */
export const MAX_WAIT_MS = 5 * 60 * 1000;
/** After a network hiccup while waiting, ask again this soon (a waiting turn lapses after 10 s). */
const RETRY_MS = 1000;

/** A turn to answer in: `until` is when it's cut off (none when there was no floor to ask). */
export interface HeldTurn {
  until?: number;
  release(): Promise<void>;
}

interface Deps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaults: Deps = {
  fetch: (...args) => fetch(...args),
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface TurnJson {
  id: string;
  status: string;
  endsInMs?: number;
}

type Outcome = { turn: TurnJson } | { refused: true } | { garbled: true };

async function call(deps: Deps, url: string, init?: RequestInit): Promise<Outcome> {
  const res = await deps.fetch(url, { cache: "no-store", ...init });
  const body: unknown = await res.json().catch(() => null);
  const turn = (body as { turn?: TurnJson } | null)?.turn;
  if (res.ok && turn && typeof turn.id === "string" && typeof turn.status === "string") return { turn };
  if (!res.ok && body && typeof body === "object" && "error" in body) return { refused: true };
  return { garbled: true };
}

const GO_AHEAD: HeldTurn = { release: async () => undefined };

/**
 * Ask for a turn and wait (up to `maxWaitMs`) until it comes. Null: don't answer (the server
 * said no, or the turn ended or never came). If the server can't be reached, go ahead.
 */
export async function takeTurn(
  base: string,
  options: { answering: Answering; speak: boolean; maxWaitMs?: number },
  deps: Deps = defaults,
): Promise<HeldTurn | null> {
  let outcome: Outcome;
  try {
    outcome = await call(deps, `${base}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answering: options.answering, speak: options.speak }),
    });
  } catch {
    return GO_AHEAD;
  }
  if ("refused" in outcome) return null;
  if ("garbled" in outcome) return GO_AHEAD;
  let turn = outcome.turn;
  const release = async () => {
    await deps.fetch(`${base}/turns/${turn.id}/done`, { method: "POST" }).catch(() => undefined);
  };
  const giveUp = deps.now() + (options.maxWaitMs ?? MAX_WAIT_MS);
  while (turn.status === "waiting" || turn.status === "held") {
    if (deps.now() >= giveUp) {
      await release();
      return null;
    }
    try {
      const next = await call(deps, `${base}/turns/${turn.id}`);
      if ("refused" in next) return null;
      if ("turn" in next) turn = next.turn;
      else await deps.sleep(RETRY_MS);
    } catch {
      await deps.sleep(RETRY_MS);
    }
  }
  if (turn.status !== "granted") return null;
  return { until: turn.endsInMs === undefined ? undefined : deps.now() + turn.endsInMs, release };
}

/**
 * The tab's answers of each kind go one at a time (the server keeps one open turn of each
 * kind per agent), and a held reply to an agent doesn't hold up an answer to a person.
 */
export class TurnQueues {
  private readonly tails: Record<Answering, Promise<unknown>> = {
    person: Promise.resolve(),
    agent: Promise.resolve(),
  };

  run<T>(kind: Answering, job: () => Promise<T>): Promise<T> {
    const next = this.tails[kind].then(job);
    this.tails[kind] = next.catch(() => undefined);
    return next;
  }
}
