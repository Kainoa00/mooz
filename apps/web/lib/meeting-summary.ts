/**
 * The host's meeting summary, as Markdown, from what their tab saw (lib/meeting-record.ts).
 * Agents' public words only: no person's own lines, no private answers, and nothing that
 * belongs to someone who opted out of notes (an agent's line belongs to the agent, its owner,
 * and whoever it answered or drew on, as for connector questions). The meeting's link and
 * everyone's internal identities never appear. Every piece of text is escaped, so nothing in
 * it can become a link, an image, HTML or a heading.
 */

import { APP_LABEL, type AssistantApp } from "./connector-protocol";
import type { Entry, MeetingRecord, Person } from "./meeting-record";
import { flatten, stripInvisible } from "./text";

export const MAX_ANSWER_CHARS = 4000;
export const MAX_TASK_SUMMARY_CHARS = 2000;
/** A task's title, the first line of its report. */
export const MAX_TITLE_CHARS = 200;
export const MAX_TASK_DETAILS_CHARS = 4000;
export const MAX_FILE_BYTES = 500 * 1024;

/**
 * Text that shows as itself in Markdown: no links (bare addresses don't turn into links
 * either), images, HTML, headings, lists or tables.
 */
export function escapeMarkdown(text: string): string {
  return stripInvisible(text)
    .normalize("NFKC")
    .replace(/[\\`*_[\]<>#|~&]/g, "\\$&") // & too: an entity like &commat; is an @ to GitHub
    .replace(/:\/\//g, ":\\/\\/")
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}\\.`)
    // GitHub links an email even after "\@", so every @ becomes a fullwidth one (after NFKC).
    .replace(/@/g, "＠")
    .replace(/^([ \t]*)([-+=])/gm, "$1\\$2")
    .replace(/^([ \t]*\d+)([.)])/gm, "$1\\$2");
}

/** One line of escaped text (a name, a title). */
const inline = (text: string) => escapeMarkdown(flatten(text, { markup: false }));

/** A block quote of escaped lines, cut at `max` characters (the mark goes on after escaping). */
function quote(text: string, max: number): string {
  const over = text.length > max;
  const block = escapeMarkdown(over ? text.slice(0, max).trimEnd() : text)
    .split(/\r\n|\r|\n/) // Markdown ends a line at a lone \r too
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return over ? `${block}…` : block;
}

function label(person: Person | undefined): string {
  if (!person) return "someone";
  if (!person.agent) return person.name;
  return `🤖 ${person.ownerName ? `${person.ownerName}'s ` : ""}${person.name}`;
}

function door(person: Person): string {
  if (person.door !== "connector") return "mooz-agent";
  return APP_LABEL[(person.app ?? "other") as AssistantApp] ?? APP_LABEL.other;
}

interface Clock {
  date: (ms: number) => string;
  time: (ms: number) => string;
}

function clock(timeZone?: string): Clock {
  const date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  return { date: (ms) => date.format(ms), time: (ms) => time.format(ms) };
}

/** `mooz-meeting-2026-10-21-1402.md`, from when the host's tab first saw the meeting. */
export function summaryFileName(record: MeetingRecord, options: { now?: number; timeZone?: string } = {}): string {
  const at = record.start ?? options.now ?? Date.now();
  const c = clock(options.timeZone);
  return `mooz-meeting-${c.date(at)}-${c.time(at).replace(":", "")}.md`;
}

/** Whose an entry is: the agent, its owner, and whoever it answered or drew on (and their owners). */
function belongsTo(record: MeetingRecord, entry: Entry): string[] {
  const named = [entry.from, ...entry.replyTo, ...entry.sources];
  const owners = named.flatMap((id) => {
    const owner = Object.hasOwn(record.people, id) ? record.people[id].ownerId : undefined;
    return owner ? [owner] : [];
  });
  return [...named, ...owners];
}

/**
 * Opted out, or someone this tab never saw (it joined late, or reloaded), so it can't know
 * whether they did: the summary leaves them out either way.
 */
function unknownOrOut(record: MeetingRecord, id: string): boolean {
  // hasOwn: an id like "constructor" (agents choose `sources`) isn't someone the tab saw.
  return !Object.hasOwn(record.people, id) || record.optedOut.includes(id);
}

function leftOut(record: MeetingRecord, identity: string): boolean {
  const owner = Object.hasOwn(record.people, identity) ? record.people[identity].ownerId : undefined;
  return unknownOrOut(record, identity) || (owner !== undefined && unknownOrOut(record, owner));
}

function answerBlock(record: MeetingRecord, entry: Entry, c: Clock): string {
  const answered = entry.replyTo.filter((id) => id !== entry.from).map((id) => inline(label(record.people[id])));
  const to = answered.length ? `, answering ${answered.join(" and ")}` : "";
  return `### ${inline(label(record.people[entry.from]))}${to} · ${c.time(entry.at)}\n\n${quote(entry.text, MAX_ANSWER_CHARS)}`;
}

function taskBlock(record: MeetingRecord, entry: Entry, c: Clock): string {
  const [first, ...rest] = entry.text.replace(/^📋\s*/u, "").split("\n");
  const body = rest.join("\n").trim();
  const split = body.indexOf("\n\n");
  const summary = split < 0 ? body : body.slice(0, split).trim();
  const details = split < 0 ? "" : body.slice(split + 2).trim();
  // Who sent it first, from the server; the title is the agent's own words, so it comes after
  // (cut short, and with no 🤖 to pass as another agent).
  const title = inline(first.replace(/🤖/gu, "").slice(0, MAX_TITLE_CHARS));
  const parts = [`### ${inline(label(record.people[entry.from]))} · ${c.time(entry.at)}: ${title}`];
  if (summary) parts.push(quote(summary, MAX_TASK_SUMMARY_CHARS));
  if (details) parts.push(quote(details, MAX_TASK_DETAILS_CHARS));
  return parts.join("\n\n");
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

export function toMarkdown(record: MeetingRecord, options: { now?: number; timeZone?: string } = {}): string {
  const c = clock(options.timeZone);
  const kept = record.entries.filter((e) => !belongsTo(record, e).some((id) => unknownOrOut(record, id)));
  const there = record.order.filter((id) => !leftOut(record, id));
  const hidden = record.order.length - there.length;

  const head: string[] = ["# Meeting summary", ""];
  if (record.start !== null && record.end !== null) {
    head.push(`- Date: ${c.date(record.start)}`, `- Seen from the host's tab: ${c.time(record.start)}–${c.time(record.end)}`, "");
  }
  head.push("## Who was there", "");
  for (const id of there) {
    const person = record.people[id];
    head.push(`- ${inline(label(person))}${person.agent ? ` (agent, through ${door(person)})` : ""}`);
  }
  if (hidden) head.push(`- and ${hidden} more left out (they asked to be, or the host's tab couldn't tell)`);
  if (!there.length && !hidden) head.push("- nobody the host's tab saw");

  const tail: string[] = [];
  const keepers = record.noteKeepers.filter((id) => !leftOut(record, id)).map((id) => inline(label(record.people[id])));
  if (keepers.length || record.pauses) {
    tail.push("## Notes and pauses", "");
    if (keepers.length) tail.push(`- Kept notes: ${keepers.join(", ")}`);
    if (record.pauses) {
      tail.push(`- The agents paused ${record.pauses === 1 ? "once" : `${record.pauses} times`} after replying to each other, until a person let them go on.`);
    }
    tail.push("");
  }
  tail.push(
    "---",
    "",
    "_Agents' public words only. People's own words, private answers, and anything to do with someone who asked to be left out of notes are not here._",
    "",
  );

  // Oldest first out, to keep the file small enough to share.
  let entries = kept;
  let dropped = record.dropped;
  const render = () => {
    const answers = entries.filter((e) => e.kind === "answer").map((e) => answerBlock(record, e, c));
    const tasks = entries.filter((e) => e.kind === "task").map((e) => taskBlock(record, e, c));
    const body: string[] = [""];
    if (dropped) body.push(`_The oldest ${dropped} agent messages were left out, to keep this file small._`, "");
    body.push("## What the agents said", "", ...(answers.length ? answers.flatMap((a) => [a, ""]) : ["Nothing public.", ""]));
    if (tasks.length) body.push("## Research", "", ...tasks.flatMap((t) => [t, ""]));
    return [...head, ...body, ...tail].join("\n");
  };
  let text = render();
  while (bytes(text) > MAX_FILE_BYTES && entries.length) {
    const drop = Math.max(1, Math.ceil(entries.length / 20));
    entries = entries.slice(drop);
    dropped += drop;
    text = render();
  }
  return text;
}
