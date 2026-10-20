import { type Answering, endTurn, requestTurn, type TurnView, waitForTurn } from "./floor";
import { HttpError, readJson } from "./http";
import { allow } from "./rate-limit";
import "./room-state"; // tells the meeting when the floor changes

/**
 * The turn-taking API both kinds of agent use: a bridge (with its claim secret) and a
 * connector agent (from its owner's tab). See docs/protocol.md, "Taking turns".
 */

/** How long one check on a turn waits for it to change before answering anyway. */
export const POLL_MS = 25_000;
/** One per answer; more than this a minute is an agent stuck in a loop. */
export const TURN_REQUESTS_PER_MINUTE = 30;
export const TURN_POLLS_PER_MINUTE = 120;
const BODY_BYTES = 1024;

/** Whose turn it is, on whose floor: the agent's identity and its meeting. */
export interface FloorAgent {
  identity: string;
  slug: string;
}

export interface TurnJson {
  id: string;
  status: TurnView["status"];
  /** For a granted turn: how long it has left (relative, so clocks needn't agree). */
  endsInMs?: number;
  reason?: TurnView["reason"];
}

export function turnJson(turn: TurnView, now = Date.now()): TurnJson {
  return {
    id: turn.id,
    status: turn.status,
    ...(turn.endsAt !== undefined ? { endsInMs: Math.max(0, turn.endsAt - now) } : {}),
    ...(turn.reason ? { reason: turn.reason } : {}),
  };
}

function limit(key: string, perMinute: number): void {
  if (!allow(key, perMinute, 60_000)) throw new HttpError(429, "rate_limited", "Too many turn requests just now");
}

const NO_STORE = { "cache-control": "no-store" };

/**
 * POST …/turns `{ answering: "person" | "agent", speak: boolean }`: ask for a turn. The body is
 * read first and the agent checked after, so one removed while its request was arriving gets
 * nothing.
 */
export async function askForTurn(req: Request, who: () => FloorAgent): Promise<Response> {
  const { answering, speak } = await readJson(req, BODY_BYTES);
  if (answering !== "person" && answering !== "agent") {
    throw new HttpError(400, "invalid_body", 'answering must be "person" or "agent"');
  }
  if (typeof speak !== "boolean") throw new HttpError(400, "invalid_body", "speak must be true or false");
  const agent = who();
  limit(`turns:${agent.identity}`, TURN_REQUESTS_PER_MINUTE);
  const turn = requestTurn(agent.slug, agent.identity, { answering: answering satisfies Answering, speak });
  return Response.json({ turn: turnJson(turn) }, { status: 201, headers: NO_STORE });
}

/** GET …/turns/{turn}: where it stands, waiting (up to POLL_MS) while it's waiting or held. */
export async function checkTurn(agent: FloorAgent, turnId: string, req: Request): Promise<Response> {
  limit(`turn-polls:${agent.identity}`, TURN_POLLS_PER_MINUTE);
  const turn = await waitForTurn(agent.slug, agent.identity, turnId, POLL_MS, req.signal);
  return Response.json({ turn: turnJson(turn) }, { headers: NO_STORE });
}

/** POST …/turns/{turn}/done: finished (or no longer wanted). */
export function finishTurn(agent: FloorAgent, turnId: string): Response {
  limit(`turn-dones:${agent.identity}`, TURN_REQUESTS_PER_MINUTE * 2);
  return Response.json({ turn: turnJson(endTurn(agent.slug, agent.identity, turnId)) }, { headers: NO_STORE });
}
