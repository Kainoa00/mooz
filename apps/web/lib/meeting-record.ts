/**
 * What the host's tab saw of a meeting, for its summary (lib/meeting-summary.ts). A pure
 * reducer: kept only in that tab's memory, never sent anywhere.
 *
 * - Only agents' public chat is kept. People's own lines, private answers (the `private`
 *   attribute, or the lock that older bridges put first), and filler ("Yes?") never enter it.
 * - Labels are snapshots taken when someone is seen: an agent's owner and door vanish from
 *   LiveKit once it leaves, and the summary still has to say whose agent it was.
 * - Anyone who opts out of notes at any point is remembered as opted out, and the summary
 *   leaves out everything of theirs.
 */

import { NOTES_OPT_OUT_ATTRIBUTE } from "./notes-protocol";

/** Agent messages kept; past this the oldest go (the summary says so). */
export const MAX_ENTRIES = 2000;
/** What an agent says that isn't an answer: acknowledgements (the bridge's and the connector's). */
export const FILLER = new Set([
  "Yes?",
  "One sec, checking.",
  "On it. I'll report back.",
  "On it. I'll tell you privately when I'm done.",
]);
const LOCK = "🔒";
const NOTES_NOTICE = "📝";
const TASK_DONE = "📋";
const TASK_FAILED = "⚠️";

export interface Person {
  name: string;
  agent: boolean;
  /** For an agent: its owner's name and identity, and how it came in. */
  ownerName?: string;
  ownerId?: string;
  door?: "bridge" | "connector";
  app?: string;
}

export interface Seen {
  identity: string;
  name?: string;
  attributes: Readonly<Record<string, string>>;
}

export interface Entry {
  kind: "answer" | "task";
  at: number;
  from: string;
  text: string;
  replyTo: string[];
  sources: string[];
}

export interface MeetingRecord {
  start: number | null;
  end: number | null;
  people: Record<string, Person>;
  /** In the order they were first seen. */
  order: string[];
  optedOut: string[];
  entries: Entry[];
  /** Entries dropped to stay under MAX_ENTRIES. */
  dropped: number;
  /** Chat message ids already handled. */
  handled: string[];
  noteKeepers: string[];
  pauses: number;
  paused: boolean;
}

export type RecordEvent =
  | { type: "present"; at: number; people: readonly Seen[] }
  | {
      type: "chat";
      at: number;
      id: string;
      from: Seen | undefined;
      text: string;
      attributes: Readonly<Record<string, string>> | undefined;
    }
  | { type: "notes"; at: number; from: Seen; state: "on" | "off" }
  | { type: "floor"; at: number; paused: boolean }
  | { type: "reset" };

export const EMPTY_RECORD: MeetingRecord = {
  start: null,
  end: null,
  people: {},
  order: [],
  optedOut: [],
  entries: [],
  dropped: 0,
  handled: [],
  noteKeepers: [],
  pauses: 0,
  paused: false,
};

const add = (list: string[], item: string) => (list.includes(item) ? list : [...list, item]);
const ids = (value: string | undefined) => (value ? value.split(",").filter(Boolean) : []);

function snapshot(seen: Seen, before: Person | undefined): Person {
  const a = seen.attributes;
  const agent = a.kind === "agent" || before?.agent === true;
  if (!agent) return { name: seen.name || before?.name || "Guest", agent: false };
  return {
    name: seen.name || before?.name || "Agent",
    agent: true,
    ownerName: a.owner_name || before?.ownerName,
    ownerId: a.owner_id || before?.ownerId,
    door: a.door === "connector" || a.door === "bridge" ? a.door : (before?.door ?? "bridge"),
    app: a.connector_app || before?.app,
  };
}

function see(record: MeetingRecord, seen: Seen): MeetingRecord {
  if (!seen.identity) return record; // not connected yet
  const before = record.people[seen.identity];
  const person = snapshot(seen, before);
  const optedOut = seen.attributes[NOTES_OPT_OUT_ATTRIBUTE] === "1" ? add(record.optedOut, seen.identity) : record.optedOut;
  return {
    ...record,
    people: { ...record.people, [seen.identity]: person },
    order: add(record.order, seen.identity),
    optedOut,
  };
}

function stamp(record: MeetingRecord, at: number): MeetingRecord {
  return { ...record, start: record.start === null ? at : Math.min(record.start, at), end: Math.max(record.end ?? at, at) };
}

/** What an agent's chat line is: an answer, a task's result, or nothing for the summary. */
function classify(text: string, attributes: Readonly<Record<string, string>> | undefined): Entry["kind"] | null {
  const line = text.trim();
  if (!line || attributes?.private === "1" || line.startsWith(LOCK) || FILLER.has(line)) return null;
  if (line.startsWith(NOTES_NOTICE) || line.startsWith(TASK_FAILED)) return null;
  return line.startsWith(TASK_DONE) ? "task" : "answer";
}

export function recordReducer(record: MeetingRecord, event: RecordEvent): MeetingRecord {
  switch (event.type) {
    case "reset":
      return EMPTY_RECORD;
    case "present": {
      let next = stamp(record, event.at);
      for (const seen of event.people) next = see(next, seen);
      return next;
    }
    case "chat": {
      if (record.handled.includes(event.id)) return record;
      let next: MeetingRecord = { ...record, handled: [...record.handled, event.id].slice(-MAX_ENTRIES * 2) };
      const from = event.from;
      // Only agents' words, and only from someone LiveKit says sent them.
      if (!from || from.attributes.kind !== "agent") return next;
      const kind = classify(event.text, event.attributes);
      if (!kind) return next;
      next = see(stamp(next, event.at), from);
      const entry: Entry = {
        kind,
        at: event.at,
        from: from.identity,
        text: event.text.trim(),
        replyTo: ids(event.attributes?.reply_to),
        sources: ids(event.attributes?.sources),
      };
      const entries = [...next.entries, entry];
      const over = Math.max(0, entries.length - MAX_ENTRIES);
      return { ...next, entries: entries.slice(over), dropped: next.dropped + over };
    }
    case "notes": {
      if (event.from.attributes.kind !== "agent" || event.state !== "on") return record;
      const next = see(stamp(record, event.at), event.from);
      return { ...next, noteKeepers: add(next.noteKeepers, event.from.identity) };
    }
    case "floor": {
      if (event.paused === record.paused) return record;
      const next = stamp(record, event.at);
      return { ...next, paused: event.paused, pauses: next.pauses + (event.paused ? 1 : 0) };
    }
  }
}

/** Whether the host's tab saw anything worth a summary. */
export function hasContent(record: MeetingRecord): boolean {
  return record.entries.length > 0 || record.order.length > 0;
}
