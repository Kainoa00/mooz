import { MAX_AGENT_STREAK } from "./floor-protocol";
import { HttpError } from "./http";
import { newId } from "./ids";

export { MAX_AGENT_STREAK };

/**
 * Who gets to answer next in a meeting, one agent at a time, kept in this server's memory
 * only (nothing outlives the meeting). Before an agent posts or speaks an answer it asks
 * for a turn. One turn is granted at a time: answers to people go ahead of replies to
 * agents, then first come first served. A turn ends when the agent is done, leaves, or runs
 * out of time. After MAX_AGENT_STREAK agent-to-agent turns in a row in the meeting, or by any
 * one agent since it last answered a person, the next reply to an agent is held (not dropped)
 * until a person in the meeting lets the agents continue.
 */

/** The longest a turn with speech may take; a chat-only turn gets less. */
export const SPEAKING_TURN_MS = 45_000;
export const CHAT_TURN_MS = 10_000;
/** A waiting or held turn goes away if its agent stops asking about it for this long. */
export const WAITING_TTL_MS = 10_000;
/** Turns open at once in one meeting (each agent has at most one of each kind). */
export const MAX_OPEN_TURNS = 20;
/** Checks waiting on one turn at once. */
export const MAX_WAITERS = 2;
/** A floor nobody has used for this long is forgotten, with its count. */
export const FLOOR_IDLE_MS = 10 * 60 * 1000;
/** How long an agent can still look up a turn that ended (to learn why). */
const ENDED_KEPT_MS = 60_000;

/** Who the agent is answering: a person (or everyone), or another agent. */
export type Answering = "person" | "agent";
export type TurnStatus = "waiting" | "held" | "granted" | "ended";
export type EndReason = "done" | "timeout" | "expired" | "left" | "replaced" | "meeting_ended";

export interface TurnView {
  id: string;
  status: TurnStatus;
  /** When a granted turn is cut off (ms since the epoch). */
  endsAt?: number;
  reason?: EndReason;
}

/** What everyone in the meeting sees: agent identities, and whether a reply is held. */
export interface FloorView {
  speaking: string | null;
  next: string | null;
  /** A reply between agents is held right now (it goes away when that reply does). */
  paused: boolean;
  /**
   * When a person last let the agents continue (ms since the epoch). Only Continue moves it up,
   * so an agent can start its own count over when it's higher than any value it has seen. It's
   * 0 after a restart, or once an idle floor is forgotten (with its count), which isn't news.
   */
  continued: number;
}

interface Turn {
  id: string;
  agent: string;
  answering: Answering;
  speak: boolean;
  status: TurnStatus;
  seq: number;
  /** Last time the agent asked about it, or stopped waiting on a poll for it. */
  seenAt: number;
  /** Polls open on it right now; while there are any, it can't expire. */
  waiters: number;
  endsAt?: number;
  endedAt?: number;
  reason?: EndReason;
}

interface Floor {
  turns: Map<string, Turn>;
  seq: number;
  /** Agent-to-agent turns granted in a row. */
  streak: number;
  /**
   * Each agent's replies to agents since it last answered a person. What a turn answers is the
   * agent's own word, so one agent claiming to answer people can't keep resetting the count above
   * and keep another replying to it.
   */
  replies: Map<string, number>;
  /** Who had the last turn: not the same agent twice in a row while another is waiting. */
  last?: string;
  /** Replies to agents are held until someone lets the agents continue. */
  paused: boolean;
  /** When someone last did (0: never). */
  continuedAt: number;
  activeAt: number;
  timer?: ReturnType<typeof setTimeout>;
  listeners: Map<string, Set<() => void>>;
}

interface Store {
  floors: Map<string, Floor>;
  onChange?: (slug: string) => void;
}

const STORE = Symbol.for("mooz.floors");

function store(): Store {
  // On globalThis: every route bundle in this process shares one set of floors.
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  return (g[STORE] ??= { floors: new Map() });
}

/** Called (synchronously) whenever what a meeting's floor shows changes. */
export function setFloorListener(listener: ((slug: string) => void) | undefined): void {
  store().onChange = listener;
}

const isOpen = (t: Turn) => t.status !== "ended";

function openTurns(floor: Floor): Turn[] {
  return [...floor.turns.values()].filter(isOpen).sort((a, b) => a.seq - b.seq);
}

function view(turn: Turn): TurnView {
  const { id, status, endsAt, reason } = turn;
  return { id, status, ...(status === "granted" ? { endsAt } : {}), ...(reason ? { reason } : {}) };
}

function setStatus(floor: Floor, turn: Turn, status: TurnStatus): void {
  if (turn.status === status) return;
  turn.status = status;
  // After the change in hand is complete: a poll that wakes up looks at the floor again.
  const listeners = floor.listeners.get(turn.id);
  if (listeners?.size) queueMicrotask(() => [...listeners].forEach((listener) => listener()));
}

function end(floor: Floor, turn: Turn, reason: EndReason, now: number): void {
  if (!isOpen(turn)) return;
  turn.reason = reason;
  turn.endedAt = now;
  setStatus(floor, turn, "ended");
}

/** Whether a reply to an agent must wait for a person: the agents have had their run. */
function mustWait(floor: Floor, reply: Turn): boolean {
  return floor.paused || floor.streak >= MAX_AGENT_STREAK || (floor.replies.get(reply.agent) ?? 0) >= MAX_AGENT_STREAK;
}

/**
 * The turn that would be granted next: answers to people first, then replies to agents, unless
 * the agents have had their run of turns. First come, first served, except that an agent doesn't
 * get two turns in a row while another agent's turn is waiting. That comes first: what a turn
 * answers is the agent's own word, so an agent that keeps saying it answers people can't keep
 * another agent waiting.
 */
function nextUp(floor: Floor, open: Turn[]): Turn | undefined {
  const waiting = open.filter((t) => t.status === "waiting");
  const candidates = [
    ...waiting.filter((t) => t.answering === "person"),
    ...waiting.filter((t) => t.answering === "agent" && !mustWait(floor, t)),
  ];
  return candidates.find((t) => t.agent !== floor.last) ?? candidates[0];
}

function grantNext(floor: Floor, now: number): void {
  const open = openTurns(floor);
  const replies = open.filter((t) => t.status === "waiting" && t.answering === "agent");
  if (!open.some((t) => t.status === "granted")) {
    const next = nextUp(floor, open);
    if (next) {
      const replies = next.answering === "person" ? 0 : (floor.replies.get(next.agent) ?? 0) + 1;
      floor.replies.set(next.agent, replies);
      floor.streak = next.answering === "person" ? 0 : floor.streak + 1;
      floor.last = next.agent;
      next.endsAt = now + (next.speak ? SPEAKING_TURN_MS : CHAT_TURN_MS);
      setStatus(floor, next, "granted");
    } else if (replies.length) {
      floor.paused = true; // the floor is free, and only replies to agents want it
    }
  }
  if (floor.paused) for (const t of replies) if (t.status === "waiting") setStatus(floor, t, "held");
}

function sweep(floor: Floor, now: number): void {
  for (const t of floor.turns.values()) {
    if (t.status === "granted" && now >= t.endsAt!) end(floor, t, "timeout", now);
    else if ((t.status === "waiting" || t.status === "held") && t.waiters === 0 && now - t.seenAt >= WAITING_TTL_MS) {
      end(floor, t, "expired", now);
    } else if (t.status === "ended" && now - t.endedAt! >= ENDED_KEPT_MS) floor.turns.delete(t.id);
  }
  grantNext(floor, now);
}

function floorView_(floor: Floor | undefined): FloorView {
  if (!floor) return { speaking: null, next: null, paused: false, continued: 0 };
  const open = openTurns(floor);
  return {
    speaking: open.find((t) => t.status === "granted")?.agent ?? null,
    next: nextUp(floor, open)?.agent ?? null,
    paused: floor.paused && open.some((t) => t.status === "held"),
    continued: floor.continuedAt,
  };
}

/** Wake up for the next thing that changes on its own: a turn running out, or going stale. */
function schedule(slug: string, floor: Floor, now: number): void {
  clearTimeout(floor.timer);
  const open = openTurns(floor);
  const deadlines = [...floor.turns.values()].map((t) =>
    t.status === "granted"
      ? t.endsAt!
      : t.status === "ended"
        ? t.endedAt! + ENDED_KEPT_MS
        : t.waiters === 0
          ? t.seenAt + WAITING_TTL_MS
          : Infinity,
  );
  if (!open.length) deadlines.push(floor.activeAt + FLOOR_IDLE_MS);
  const at = Math.min(...deadlines);
  if (at === Infinity) return;
  floor.timer = setTimeout(() => tick(slug), Math.max(0, at - now));
  floor.timer.unref?.();
}

function tick(slug: string): void {
  const floor = store().floors.get(slug);
  if (!floor) return;
  const now = Date.now();
  if (!openTurns(floor).length && now - floor.activeAt >= FLOOR_IDLE_MS) {
    store().floors.delete(slug);
    return;
  }
  update(slug, floor, () => undefined);
}

/** Change a floor, then grant whoever is next, set the next wake-up, and tell the meeting. */
function update<T>(slug: string, floor: Floor, change: (now: number) => T): T {
  const now = Date.now();
  const before = JSON.stringify(floorView_(floor));
  try {
    sweep(floor, now);
    const result = change(now);
    sweep(floor, now);
    return result;
  } finally {
    schedule(slug, floor, now);
    if (JSON.stringify(floorView_(floor)) !== before) store().onChange?.(slug);
  }
}

function floorFor(slug: string): Floor {
  const floors = store().floors;
  let floor = floors.get(slug);
  if (!floor) {
    floor = {
      turns: new Map(),
      seq: 0,
      streak: 0,
      continuedAt: 0,
      replies: new Map(),
      paused: false,
      activeAt: Date.now(),
      listeners: new Map(),
    };
    floors.set(slug, floor);
  }
  return floor;
}

function find(slug: string, agent: string, turnId: string): { floor: Floor; turn: Turn } {
  const floor = store().floors.get(slug);
  const turn = floor?.turns.get(turnId);
  if (!floor || !turn || turn.agent !== agent) throw new HttpError(404, "turn_not_found", "No such turn");
  return { floor, turn };
}

/**
 * Ask for a turn. An agent has at most one open turn of each kind (so a reply to an agent that
 * is held doesn't stop it answering a person): asking again replaces the last of that kind.
 */
export function requestTurn(slug: string, agent: string, input: { answering: Answering; speak: boolean }): TurnView {
  const floor = floorFor(slug);
  const mine = (t: Turn) => t.agent === agent && t.answering === input.answering;
  const turn = update(slug, floor, (now) => {
    if (openTurns(floor).filter((t) => !mine(t)).length >= MAX_OPEN_TURNS) {
      throw new HttpError(429, "floor_busy", "Too many agents are waiting to answer in this meeting");
    }
    floor.activeAt = now;
    for (const t of openTurns(floor)) if (mine(t)) end(floor, t, "replaced", now);
    const turn: Turn = {
      id: newId("t"),
      agent,
      answering: input.answering,
      speak: input.speak,
      status: "waiting",
      seq: ++floor.seq,
      seenAt: now,
      waiters: 0,
    };
    floor.turns.set(turn.id, turn);
    return turn;
  });
  return view(turn);
}

/** Where a turn stands. Asking keeps a waiting turn alive. */
export function getTurn(slug: string, agent: string, turnId: string): TurnView {
  const { floor, turn } = find(slug, agent, turnId);
  return update(slug, floor, (now) => {
    if (isOpen(turn)) turn.seenAt = now;
    return view(turn);
  });
}

/**
 * Wait (up to `timeoutMs`, or until `signal` aborts) for a waiting or held turn to change.
 * Resolves with the turn as it then stands.
 */
export function waitForTurn(
  slug: string,
  agent: string,
  turnId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TurnView> {
  const { floor, turn } = find(slug, agent, turnId);
  const start = getTurn(slug, agent, turnId);
  if (start.status !== "waiting" && start.status !== "held") return Promise.resolve(start);
  if (turn.waiters >= MAX_WAITERS) {
    throw new HttpError(429, "too_many_checks", "This turn is already being checked");
  }
  return new Promise((resolve) => {
    const listeners = floor.listeners.get(turn.id) ?? new Set();
    floor.listeners.set(turn.id, listeners);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      listeners.delete(changed);
      if (!listeners.size) floor.listeners.delete(turn.id);
      turn.seenAt = Date.now(); // it was being waited on until now
      turn.waiters -= 1;
      if (store().floors.get(slug) !== floor) resolve(view(turn));
      else resolve(update(slug, floor, () => view(turn)));
    };
    const changed = () => {
      if (turn.status !== start.status) finish();
    };
    turn.waiters += 1;
    listeners.add(changed);
    const timer = setTimeout(finish, timeoutMs);
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}

/** The agent is done with its turn (or no longer wants one it was waiting for). */
export function endTurn(slug: string, agent: string, turnId: string): TurnView {
  const { floor, turn } = find(slug, agent, turnId);
  return update(slug, floor, (now) => {
    floor.activeAt = now;
    end(floor, turn, "done", now);
    return view(turn);
  });
}

/** An agent left the meeting or was removed: its turns are over. */
export function leaveFloor(slug: string, agent: string): void {
  const floor = store().floors.get(slug);
  if (!floor) return;
  update(slug, floor, (now) => {
    for (const t of openTurns(floor)) if (t.agent === agent) end(floor, t, "left", now);
  });
}

/** An agent was taken out (or its connection is gone): its turns in any meeting are over. */
export function leaveFloors(agent: string): void {
  for (const slug of [...store().floors.keys()]) leaveFloor(slug, agent);
}

/** A person lets the agents go on: held replies go out, and the count starts over. */
export function continueAgents(slug: string): boolean {
  const floor = store().floors.get(slug);
  if (!floor) return false;
  return update(slug, floor, (now) => {
    const held = openTurns(floor).filter((t) => t.status === "held");
    if (!held.length) return false;
    floor.paused = false;
    floor.streak = 0;
    floor.replies.clear();
    floor.continuedAt = Math.max(now, floor.continuedAt + 1);
    floor.activeAt = now;
    for (const t of held) {
      t.seenAt = now;
      setStatus(floor, t, "waiting");
    }
    return true;
  });
}

/** The meeting is over: every turn ends and the floor is forgotten. */
export function endFloor(slug: string): void {
  const floor = store().floors.get(slug);
  if (!floor) return;
  const now = Date.now();
  for (const t of floor.turns.values()) end(floor, t, "meeting_ended", now);
  clearTimeout(floor.timer);
  store().floors.delete(slug);
  store().onChange?.(slug);
}

export function floorView(slug: string): FloorView {
  return floorView_(store().floors.get(slug));
}

export function resetFloorsForTests(): void {
  for (const floor of store().floors.values()) clearTimeout(floor.timer);
  store().floors.clear();
}
