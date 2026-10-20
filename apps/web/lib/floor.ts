import { HttpError } from "./http";
import { newId } from "./ids";

/**
 * Who gets to answer next in a meeting, one agent at a time, kept in this server's memory
 * only (nothing outlives the meeting). Before an agent posts or speaks an answer it asks
 * for a turn. One turn is granted at a time: answers to people go ahead of replies to
 * agents, then first come first served. A turn ends when the agent is done, leaves, or runs
 * out of time. After MAX_AGENT_STREAK agent-to-agent turns in a row, the next reply to an
 * agent is held (not dropped) until a person in the meeting lets the agents continue.
 */

/** The longest a turn with speech may take; a chat-only turn gets less. */
export const SPEAKING_TURN_MS = 45_000;
export const CHAT_TURN_MS = 10_000;
/** A waiting or held turn goes away if its agent stops asking about it for this long. */
export const WAITING_TTL_MS = 10_000;
/** Agent-to-agent turns in a row before the next one waits for a person. */
export const MAX_AGENT_STREAK = 3;
/** Turns open at once in one meeting (each agent has at most one). */
export const MAX_OPEN_TURNS = 20;
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
  paused: boolean;
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
  /** Replies to agents are held until someone lets the agents continue. */
  paused: boolean;
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

/**
 * The turn that would be granted next: answers to people first, then replies to agents,
 * unless the agents have had their run of turns.
 */
function nextUp(floor: Floor, open: Turn[]): Turn | undefined {
  const waiting = open.filter((t) => t.status === "waiting");
  const repliesWait = floor.paused || floor.streak >= MAX_AGENT_STREAK;
  return waiting.find((t) => t.answering === "person") ?? (repliesWait ? undefined : waiting[0]);
}

function grantNext(floor: Floor, now: number): void {
  const open = openTurns(floor);
  const replies = open.filter((t) => t.status === "waiting" && t.answering === "agent");
  if (!open.some((t) => t.status === "granted")) {
    const next = nextUp(floor, open);
    if (next) {
      floor.streak = next.answering === "person" ? 0 : floor.streak + 1;
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
  if (!floor) return { speaking: null, next: null, paused: false };
  const open = openTurns(floor);
  return {
    speaking: open.find((t) => t.status === "granted")?.agent ?? null,
    next: nextUp(floor, open)?.agent ?? null,
    paused: floor.paused && open.some((t) => t.status === "held"),
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
    floor = { turns: new Map(), seq: 0, streak: 0, paused: false, activeAt: Date.now(), listeners: new Map() };
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

/** Ask for a turn. An agent has one open turn at most: asking again replaces the last. */
export function requestTurn(slug: string, agent: string, input: { answering: Answering; speak: boolean }): TurnView {
  const floor = floorFor(slug);
  const turn = update(slug, floor, (now) => {
    if (openTurns(floor).filter((t) => t.agent !== agent).length >= MAX_OPEN_TURNS) {
      throw new HttpError(429, "floor_busy", "Too many agents are waiting to answer in this meeting");
    }
    floor.activeAt = now;
    for (const t of openTurns(floor)) if (t.agent === agent) end(floor, t, "replaced", now);
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
