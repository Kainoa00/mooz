import type { ConnectorAgent } from "./connector-agents";
import type { AnswerPacket } from "./connector-protocol";
import type { Db } from "./db";
import { HttpError } from "./http";
import { newId } from "./ids";
import { flatten, stripInvisible } from "./text";

/**
 * Questions for connector agents, in this server's memory only: nothing outlives the
 * meeting (questions expire after 10 minutes). The owner's tab hears the meeting and
 * sends each question with what was said lately. Every line is checked against the
 * meeting here: names and roles come from the server, and anyone who opted out of
 * notes is left out, since assistant apps keep chat history and may remember it.
 */

export const QUESTION_TTL_MS = 10 * 60 * 1000;
export const CONTEXT_WINDOW_MS = 10 * 60 * 1000;
export const MAX_WAITING = 5;
export const MAX_LINES = 500;
export const MAX_LINE_CHARS = 1000;
export const MAX_QUESTION_CHARS = 1000;
export const MAX_CONTEXT_CHARS = 12_000;
export const MAX_SPOKEN_CHARS = 400;
export const MAX_DETAILS_CHARS = 4000;
/** Waiting and answered questions kept per agent. */
export const MAX_ENTRIES = 20;
/**
 * People a question's lines may belong to. A line that would take it past this is left out
 * (never cut short: a person dropped from a line's list could no longer take it out by opting out).
 */
export const MAX_ENTRY_PEOPLE = 100;
/** Lines kept with a question (the newest; the text is capped at MAX_CONTEXT_CHARS too). */
export const MAX_ENTRY_LINES = 200;
const MAX_AGENTS = 200;
const SWEEP_EVERY_MS = 60_000;

export type Role = "owner" | "guest" | "agent" | "you";

export interface MeetingLine {
  speaker: string;
  role: Role;
  name: string;
  kind: "human" | "agent";
  via: "voice" | "chat";
  text: string;
  at: number;
}

export interface Asker {
  identity: string;
  name: string;
  role: Exclude<Role, "you">;
  kind: "human" | "agent";
}

export interface Question {
  id: string;
  asker: Asker;
  /** One line, as said (escape it before putting it in front of a model). */
  text: string;
  askedAt: number;
  status: "waiting" | "answered";
  /** The owner tapped to send it to their assistant; only then can the assistant read it. */
  released: boolean;
}

/** What the owner's tab gets (as a LiveKit data packet) to post and speak as the agent. */
export type { AnswerPacket };

interface Entry {
  question: Question;
  lines: StoredLine[];
  /** Everyone the lines belong to; a line's `belongs` indexes into it. */
  table: string[];
  /** The line that asked it (who, when), so dismissing it removes that line everywhere. */
  askedLine?: { speaker: string; at: number };
  replyTo: string;
  people: string[];
  answer?: AnswerPacket;
}

/** A question as its owner's tab sees it: with the answer once there is one. */
export type QuestionView = Question & { answer?: AnswerPacket };

/** A line as kept: with everyone it belongs to, so a later opt-out still removes it. */
type StoredLine = MeetingLine & { belongs: Uint8Array; heard?: number };
type ParsedLine = MeetingLine & { people: string[]; heard?: number };

interface AgentState {
  entries: Entry[];
  touched: number;
}

const STORE = Symbol.for("mooz.connectorQueue");

function store(): Map<string, AgentState> {
  // On globalThis: every route bundle in this process shares one queue.
  const g = globalThis as unknown as Record<symbol, Map<string, AgentState> | undefined>;
  return (g[STORE] ??= new Map());
}

let lastSweep = 0;

/** Agents untouched for longer than a question lives hold nothing worth keeping. */
function sweep(all: Map<string, AgentState>, now: number): void {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [identity, state] of all) if (now - state.touched > QUESTION_TTL_MS) all.delete(identity);
}

function stateFor(agentIdentity: string, now: number, create: boolean): AgentState | undefined {
  const all = store();
  sweep(all, now);
  let state = all.get(agentIdentity);
  if (!state && create) {
    if (all.size >= MAX_AGENTS) {
      const oldest = [...all.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
      all.delete(oldest[0]);
    }
    state = { entries: [], touched: now };
    all.set(agentIdentity, state);
  }
  if (state) {
    state.entries = state.entries.filter((e) => now - e.question.askedAt <= QUESTION_TTL_MS);
    state.touched = now;
  }
  return state;
}

interface Person {
  name: string;
  kind: "human" | "agent";
  /** For an agent, the person behind it. */
  owner?: string;
  optedOut: boolean;
}

/** Everyone in the meeting, by identity, as the server knows them. */
function peopleIn(db: Db, slug: string): Map<string, Person> {
  const people = new Map<string, Person>();
  const humans = db
    .prepare("SELECT identity, name, notes_opt_out FROM participants WHERE room_slug = ?")
    .all(slug) as { identity: string; name: string; notes_opt_out: number }[];
  for (const h of humans) people.set(h.identity, { name: h.name, kind: "human", optedOut: h.notes_opt_out === 1 });
  const agents = db
    .prepare("SELECT agent_identity, agent_name, owner_identity FROM agent_requests WHERE room_slug = ? AND status = 'approved'")
    .all(slug) as { agent_identity: string; agent_name: string; owner_identity: string }[];
  for (const a of agents) {
    people.set(a.agent_identity, { name: a.agent_name, kind: "agent", owner: a.owner_identity, optedOut: false });
  }
  return people;
}

function roleOf(agent: ConnectorAgent, identity: string, person: Person): Role {
  if (identity === agent.identity) return "you";
  if (identity === agent.ownerIdentity) return "owner";
  return person.kind === "agent" ? "agent" : "guest";
}

/** The person behind a speaker (an agent stands for its owner). */
const personOf = (identity: string, person: Person) => (person.kind === "agent" && person.owner ? person.owner : identity);

/** The people a line names, as long as they're in this meeting (nobody else matters to opt-outs). */
function namedPeople(value: unknown, people: Map<string, Person>): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.filter((v): v is string => typeof v === "string" && people.has(v));
}

function parseLines(
  value: unknown,
  agent: ConnectorAgent,
  people: Map<string, Person>,
  now: number,
): { lines: StoredLine[]; table: string[] } {
  if (!Array.isArray(value) || value.length > MAX_LINES) {
    throw new HttpError(400, "invalid_lines", `Send at most ${MAX_LINES} lines of the meeting`);
  }
  const optedOut = (identity: string) => people.get(identity)?.optedOut === true;
  const lines: ParsedLine[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.identity !== "string" || typeof item.text !== "string") continue;
    const person = people.get(item.identity);
    if (!person) continue; // not in this meeting
    const at = typeof item.at === "number" && Number.isFinite(item.at) ? Math.min(item.at, now) : now;
    if (now - at > CONTEXT_WINDOW_MS) continue;
    // Left out if anyone it belongs to opted out (as the bridge's notes do).
    const belongs = [
      ...new Set([
        item.identity,
        ...(person.owner ? [person.owner] : []),
        ...namedPeople(item.reply_to, people),
        ...namedPeople(item.sources, people),
      ]),
    ];
    if (belongs.some(optedOut)) continue;
    const text = flatten(item.text).slice(0, MAX_LINE_CHARS);
    if (!text.trim()) continue;
    lines.push({
      speaker: item.identity,
      role: roleOf(agent, item.identity, person),
      name: person.name,
      kind: person.kind,
      via: item.via === "voice" ? "voice" : "chat",
      text,
      at,
      people: belongs,
      // The tab's own time for it, unclamped, to find it again (on dismiss) whatever the clocks say.
      ...(typeof item.at === "number" ? { heard: item.at } : {}),
    });
  }
  lines.sort((a, b) => a.at - b.at);
  // The newest that fit, with everyone they belong to in one small table.
  const kept: StoredLine[] = [];
  const index = new Map<string, number>();
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_ENTRY_LINES; i--) {
    const { people: owners, ...line } = lines[i];
    if (size + line.text.length > MAX_CONTEXT_CHARS) break;
    const newcomers = owners.filter((identity) => !index.has(identity));
    if (index.size + newcomers.length > MAX_ENTRY_PEOPLE) continue; // can't track them all: leave it out
    for (const identity of newcomers) index.set(identity, index.size);
    size += line.text.length;
    kept.unshift({ ...line, belongs: Uint8Array.from(owners, (identity) => index.get(identity)!) });
  }
  return { lines: kept, table: [...index.keys()] };
}

/** The owner's tab heard someone address the agent. */
export function enqueueQuestion(
  db: Db,
  agent: ConnectorAgent,
  input: { asker: unknown; text: unknown; lines: unknown; at?: unknown },
  now = Date.now(),
): Question {
  const people = peopleIn(db, agent.slug);
  const askerPerson = typeof input.asker === "string" ? people.get(input.asker) : undefined;
  if (typeof input.asker !== "string" || !askerPerson || input.asker === agent.identity) {
    throw new HttpError(400, "invalid_asker", "Whoever asked isn't in this meeting");
  }
  const text = typeof input.text === "string" ? flatten(input.text, { markup: false }).trim() : "";
  if (!text || text.length > MAX_QUESTION_CHARS) {
    throw new HttpError(400, "invalid_question", `A question is 1–${MAX_QUESTION_CHARS} characters`);
  }
  const { lines, table } = parseLines(input.lines, agent, people, now);
  const role = roleOf(agent, input.asker, askerPerson) as Asker["role"];
  const question: Question = {
    id: newId("q"),
    asker: { identity: input.asker, name: askerPerson.name, role, kind: askerPerson.kind },
    text,
    askedAt: now,
    status: "waiting",
    released: false,
  };
  const replyTo = personOf(input.asker, askerPerson);
  // Everyone whose words the answer may draw on: the asker and everyone the lines belong to
  // (as the bridge does), so the answer leaves notes and later context if any of them opts out.
  const people_ = [...new Set([replyTo, ...table])];

  const askedAt = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : undefined;
  const state = stateFor(agent.identity, now, true)!;
  state.entries.push({
    question,
    lines,
    table,
    ...(askedAt !== undefined ? { askedLine: { speaker: input.asker, at: askedAt } } : {}),
    replyTo,
    people: people_,
  });
  const waiting = state.entries.filter((e) => e.question.status === "waiting");
  for (const extra of waiting.slice(0, Math.max(0, waiting.length - MAX_WAITING))) {
    state.entries.splice(state.entries.indexOf(extra), 1);
  }
  if (state.entries.length > MAX_ENTRIES) state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  return question;
}

/** The questions the owner's tab can see (waiting and answered, until they expire). */
export function listQuestions(agentIdentity: string, now = Date.now()): QuestionView[] {
  return (stateFor(agentIdentity, now, false)?.entries ?? []).map((e) =>
    e.answer ? { ...e.question, answer: e.answer } : { ...e.question },
  );
}

/** Lines as they may be shared now: anyone who opted out since the question came in is left out too. */
function shareable(db: Db, agent: ConnectorAgent, entry: Entry, lines = entry.lines): MeetingLine[] {
  const people = peopleIn(db, agent.slug);
  const out = entry.table.map((identity) => people.get(identity)?.optedOut === true);
  return lines
    .filter((l) => !l.belongs.some((i) => out[i]))
    .map(({ speaker, role, name, kind, via, text, at }) => ({ speaker, role, name, kind, via, text, at }));
}

function entryFor(agentIdentity: string, id: unknown, now: number): Entry {
  const entry = (stateFor(agentIdentity, now, false)?.entries ?? []).find((e) => e.question.id === id);
  if (!entry) throw new HttpError(404, "question_not_found", "No such question (it may have expired)");
  return entry;
}

/** The owner tapped to send this question to their assistant. */
export function releaseQuestion(agentIdentity: string, id: unknown, now = Date.now()): Question {
  const entry = entryFor(agentIdentity, id, now);
  entry.question.released = true;
  return entry.question;
}

/** The owner dismissed it: it's gone, for the assistant too. */
export function dismissQuestion(agentIdentity: string, id: unknown, now = Date.now()): void {
  const state = stateFor(agentIdentity, now, false)!;
  const entry = entryFor(agentIdentity, id, now);
  state.entries.splice(state.entries.indexOf(entry), 1);
  // Other questions sent the line that asked it as meeting text: it goes from those too.
  const asked = entry.askedLine;
  if (asked) {
    for (const other of state.entries) {
      other.lines = other.lines.filter((l) => !(l.speaker === asked.speaker && l.heard === asked.at));
    }
  }
}

/**
 * A waiting question the owner sent to the assistant (the oldest, unless one is named) and
 * what the meeting said around it. Questions the owner hasn't tapped don't exist here.
 */
export function getQuestion(
  db: Db,
  agent: ConnectorAgent,
  id: string | undefined,
  now = Date.now(),
): { question: Question; lines: MeetingLine[] } | undefined {
  const waiting = (stateFor(agent.identity, now, false)?.entries ?? []).filter(
    (e) => e.question.status === "waiting" && e.question.released,
  );
  const entry = id === undefined ? waiting[0] : waiting.find((e) => e.question.id === id);
  return entry ? { question: entry.question, lines: shareable(db, agent, entry) } : undefined;
}

/**
 * The meeting around the newest question the owner sent the assistant (the last 10 minutes of
 * it), or nothing while no such question waits: a link alone never reads the meeting.
 */
export function meetingLines(db: Db, agent: ConnectorAgent, now = Date.now()): MeetingLine[] {
  const released = (stateFor(agent.identity, now, false)?.entries ?? []).filter(
    (e) => e.question.status === "waiting" && e.question.released,
  );
  const newest = released.at(-1);
  return newest ? shareable(db, agent, newest, newest.lines.filter((l) => now - l.at <= CONTEXT_WINDOW_MS)) : [];
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The assistant's answer, or the one its owner pasted (`by: "owner"`), ready to post and
 * speak. The assistant can answer only a question its owner sent it.
 */
export function answerQuestion(
  agentIdentity: string,
  id: unknown,
  input: { spoken: unknown; details?: unknown },
  { by = "assistant", now = Date.now() }: { by?: "assistant" | "owner"; now?: number } = {},
): AnswerPacket {
  const entry = entryFor(agentIdentity, id, now);
  if (by === "assistant" && !entry.question.released) {
    throw new HttpError(404, "question_not_found", "No such question (it may have expired)");
  }
  if (entry.question.status === "answered") {
    throw new HttpError(409, "already_answered", "That question was already answered");
  }
  const spoken = typeof input.spoken === "string" ? stripInvisible(input.spoken).trim() : "";
  if (!spoken) throw new HttpError(400, "invalid_answer", "An answer needs something to say");
  const details = typeof input.details === "string" ? stripInvisible(input.details).trim() : "";
  entry.question.status = "answered";
  entry.lines = []; // answered: nothing reads them again
  entry.table = [];
  entry.answer = {
    type: "answer",
    id: entry.question.id,
    spoken: cap(spoken, MAX_SPOKEN_CHARS),
    details: cap(details, MAX_DETAILS_CHARS),
    reply_to: entry.replyTo,
    sources: entry.people,
  };
  return entry.answer;
}

/** The agent left: drop everything it was holding. */
export function forgetAgent(agentIdentity: string): void {
  store().delete(agentIdentity);
}

export function resetQueueForTests(): void {
  store().clear();
  lastSweep = 0;
}
