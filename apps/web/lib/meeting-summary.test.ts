import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { EMPTY_RECORD, FILLER, MAX_ENTRIES, recordReducer, type MeetingRecord, type RecordEvent, type Seen } from "./meeting-record";
import {
  MAX_ANSWER_CHARS,
  MAX_FILE_BYTES,
  MAX_TASK_DETAILS_CHARS,
  MAX_TASK_SUMMARY_CHARS,
  escapeMarkdown,
  summaryFileName,
  toMarkdown,
} from "./meeting-summary";

const T0 = Date.UTC(2026, 9, 21, 14, 2);
const MIN = 60_000;
const TZ = { timeZone: "UTC" };

const kai: Seen = { identity: "p_kai0000000000000", name: "Kainoa", attributes: { kind: "human" } };
const zach: Seen = { identity: "p_zach000000000000", name: "Zach", attributes: { kind: "human" } };
const lee: Seen = { identity: "p_lee00000000000000", name: "Lee", attributes: { kind: "human", notes_opt_out: "1" } };
const atlas: Seen = {
  identity: "a_atlas00000000000",
  name: "Atlas",
  attributes: { kind: "agent", door: "bridge", owner_id: zach.identity, owner_name: "Zach" },
};
const grok: Seen = {
  identity: "a_grok000000000000",
  name: "Grok",
  attributes: { kind: "agent", door: "connector", connector_app: "grok", owner_id: kai.identity, owner_name: "Kainoa" },
};
const orion: Seen = {
  identity: "a_orion00000000000",
  name: "Orion",
  attributes: { kind: "agent", door: "bridge", owner_id: lee.identity, owner_name: "Lee" },
};

let n = 0;
function chat(from: Seen, text: string, attributes: Record<string, string> = {}, at = T0 + MIN): RecordEvent {
  return { type: "chat", at, id: `m${++n}`, from, text, attributes };
}

function play(...events: RecordEvent[]): MeetingRecord {
  return events.reduce(recordReducer, EMPTY_RECORD);
}

const meeting = (...events: RecordEvent[]) =>
  play({ type: "present", at: T0, people: [kai, zach, lee, atlas, grok, orion] }, ...events);

/** What a reader sees: the summary rendered as GitHub-flavoured Markdown. */
const html = (record: MeetingRecord) => marked.parse(toMarkdown(record, TZ), { async: false, gfm: true });

describe("the meeting record", () => {
  it("keeps agents' public answers, and never people's own lines", () => {
    const r = meeting(chat(zach, "@Atlas when is the launch?"), chat(atlas, "March 30th.", { reply_to: zach.identity }));
    expect(r.entries.map((e) => e.text)).toEqual(["March 30th."]);
    expect(JSON.stringify(r)).not.toContain("when is the launch");
  });

  it("drops private answers, from today's bridges and older ones, and filler", () => {
    const r = meeting(
      chat(atlas, "Your salary is 100k.", { private: "1", reply_to: zach.identity }),
      chat(atlas, "🔒 Your salary is 100k.", { reply_to: zach.identity }),
      ...[...FILLER].map((f) => chat(grok, f)),
      chat(atlas, "📝 Zach's Atlas is keeping notes."),
      chat(atlas, "⚠️ Look into the outage\n\nI could not finish it."),
    );
    expect(r.entries).toEqual([]);
  });

  it("drops a private task's report from older bridges, once the tab knows the task is private", () => {
    const r = meeting(
      { type: "private-task", agent: atlas.identity, title: "Find out the launch date" },
      chat(atlas, "📋 Find out the launch date\n\nMarch 30th.", { reply_to: zach.identity }),
      chat(grok, "📋 Find out the launch date\n\nA public one, from another agent."),
    );
    expect(r.entries.map((e) => e.text)).toEqual(["📋 Find out the launch date\n\nA public one, from another agent."]);
  });

  it("keeps the private task it heard of last, however many others came before", () => {
    const flood = (from: number, n: number) =>
      Array.from({ length: n }, (_, i): RecordEvent => ({ type: "private-task", agent: grok.identity, title: `t${from + i}` }));
    const task: RecordEvent = { type: "private-task", agent: atlas.identity, title: "Find out the launch date" };
    const r = meeting(
      task,
      ...flood(0, 10),
      task, // its last update, just before its report: to the back of the list
      ...flood(10, MAX_ENTRIES - 1),
      chat(atlas, "📋 Find out the launch date\n\nMarch 30th.", { reply_to: zach.identity }),
    );
    expect(r.entries).toEqual([]);
  });

  it("drops a private task's report when its title is longer than the task panel keeps", () => {
    const long = `Compare ${"the vendors ".repeat(30)}`.trim();
    const r = meeting(
      { type: "private-task", agent: atlas.identity, title: long.slice(0, 200) },
      chat(atlas, `📋 ${long}\n\nVendor B.`, { reply_to: zach.identity }),
    );
    expect(r.entries).toEqual([]);
  });

  it("takes a message once, and only from an agent LiveKit says sent it", () => {
    const once = chat(atlas, "March 30th.");
    const r = meeting(once, once, { ...(chat(atlas, "spoofed") as Extract<RecordEvent, { type: "chat" }>), from: undefined }, chat({ ...zach, name: "🤖 Atlas" }, "fake"));
    expect(r.entries.map((e) => e.text)).toEqual(["March 30th."]);
  });

  it("waits for someone's identity (the host's own arrives with the connection)", () => {
    const r = play({ type: "present", at: T0, people: [{ identity: "", name: "", attributes: {} }, kai] });
    expect(r.order).toEqual([kai.identity]);
  });

  it("keeps an agent's label after it has left", () => {
    const r = play(
      { type: "present", at: T0, people: [zach, atlas] },
      { type: "present", at: T0 + MIN, people: [zach, { ...atlas, attributes: {} }] },
    );
    expect(r.people[atlas.identity]).toMatchObject({ agent: true, ownerName: "Zach", door: "bridge" });
  });

  it("remembers anyone who opted out at any point", () => {
    const r = play(
      { type: "present", at: T0, people: [{ ...zach, attributes: { kind: "human", notes_opt_out: "1" } }] },
      { type: "present", at: T0 + MIN, people: [zach] },
    );
    expect(r.optedOut).toEqual([zach.identity]);
  });

  it("counts pauses and who kept notes", () => {
    const r = meeting(
      { type: "floor", at: T0, paused: true },
      { type: "floor", at: T0 + MIN, paused: true },
      { type: "floor", at: T0 + 2 * MIN, paused: false },
      { type: "floor", at: T0 + 3 * MIN, paused: true },
      { type: "notes", at: T0, from: atlas, state: "on" },
      { type: "notes", at: T0, from: zach, state: "on" }, // only agents keep notes
    );
    expect([r.pauses, r.noteKeepers]).toEqual([2, [atlas.identity]]);
  });

  it("keeps the newest messages, and counts the ones it let go", () => {
    let r = meeting();
    for (let i = 0; i < MAX_ENTRIES + 5; i++) r = recordReducer(r, chat(atlas, `answer ${i}`));
    expect(r.entries).toHaveLength(MAX_ENTRIES);
    expect(r.entries[0].text).toBe("answer 5");
    expect(r.dropped).toBe(5);
  });
});

describe("toMarkdown", () => {
  it("says when, who was there, and what the agents said to whom", () => {
    const text = toMarkdown(
      meeting(
        chat(atlas, "March 30th.", { reply_to: zach.identity }, T0 + 3 * MIN),
        chat(grok, "The build is green.", { reply_to: `${kai.identity},${zach.identity}` }, T0 + 5 * MIN),
      ),
      TZ,
    );
    expect(text).toContain("- Date: 2026-10-21\n- Seen from the host's tab: 14:02–14:07");
    expect(text).toContain("- Kainoa\n- Zach\n- 🤖 Zach's Atlas (agent, through mooz-agent)\n- 🤖 Kainoa's Grok (agent, through Grok)");
    expect(text).toContain("### 🤖 Zach's Atlas, answering Zach · 14:05\n\n> March 30th.");
    expect(text).toContain("### 🤖 Kainoa's Grok, answering Kainoa and Zach · 14:07");
  });

  it("leaves out everything that belongs to someone who opted out", () => {
    const text = toMarkdown(
      meeting(
        chat(orion, "Lee's agent speaking."), // owner opted out
        chat(atlas, "Answer to Lee.", { reply_to: lee.identity }),
        chat(atlas, "Drawn from Lee's words.", { reply_to: zach.identity, sources: `${zach.identity},${lee.identity}` }),
        chat(atlas, "Answer to Orion.", { reply_to: orion.identity }), // an agent whose owner opted out
        chat(atlas, "Fine to keep.", { reply_to: zach.identity }),
      ),
      TZ,
    );
    expect(text).toContain("Fine to keep");
    for (const gone of ["Lee's agent", "Answer to Lee", "Drawn from", "Answer to Orion", "Lee", "Orion"]) {
      expect(text).not.toContain(gone);
    }
    expect(text).toContain("- and 2 more left out");
  });

  it("leaves out answers drawing on someone the host's tab never saw (they may have opted out)", () => {
    // The host reloaded: Lee opted out, spoke and left before this tab saw her, and her agent
    // stayed on.
    const later = play(
      { type: "present", at: T0, people: [kai, zach, atlas, orion] },
      chat(atlas, "Drawn from Lee's words.", { reply_to: zach.identity, sources: `${zach.identity},${lee.identity}` }),
      chat(orion, "Lee's agent speaking."),
      chat(atlas, "Fine to keep.", { reply_to: zach.identity }),
    );
    const text = toMarkdown(later, TZ);
    expect(text).toContain("Fine to keep");
    for (const gone of ["Drawn from", "Lee's agent", "Orion"]) expect(text).not.toContain(gone);
    expect(text).toContain("- and 1 more left out");
    // An id that only looks like one the tab knows is still unknown.
    const tricky = play({ type: "present", at: T0, people: [kai, zach, atlas] }, chat(atlas, "Sneaky.", { sources: "constructor" }));
    expect(toMarkdown(tricky, TZ)).not.toContain("Sneaky");
  });

  it("keeps an answer inside its quote across a lone carriage return", () => {
    const text = toMarkdown(meeting(chat(atlas, "quoted\r\rThe agents paused 3 times", { reply_to: zach.identity })), TZ);
    expect(text).toContain("> quoted\n>\n> The agents paused 3 times");
  });

  it("leaves no www. or @ for GitHub's own autolinks to find", () => {
    // cmark-gfm links "me\\@evil.test" though marked doesn't, so check the text itself.
    const text = escapeMarkdown("_www.evil.test me@evil.test mailto:me@evil.test xmpp:a@b_c.test me&commat;evil.test");
    expect(text).not.toMatch(/www\.|@|(?<!\\)&/i);
  });

  it("has no meeting link, slug or internal identity in it", () => {
    const text = toMarkdown(meeting(chat(atlas, "March 30th.", { reply_to: zach.identity, sources: kai.identity })), TZ);
    expect(text).not.toMatch(/[pa]_[a-z0-9]{6,}|lk_|\/r\//);
  });

  it.each([
    ["an image", "![x](https://evil.test/pixel.png)", /<img/],
    ["a link", "[click](https://evil.test)", /<a /],
    ["a bare address", "see https://evil.test or www.evil.test or me@evil.test", /<a /],
    ["an address after an underscore", "see _www.evil.test or xmpp:me@evil_x.test", /<a /],
    ["HTML", '<img src="x" onerror="alert(1)">', /<img/],
    ["a heading", "# You're fired", /<h1/],
    ["a heading made with a line under it", "Totally real\n===", /<h1/],
    ["a table", "| a | b |\n|---|---|\n| 1 | 2 |", /<table/],
    ["a list", "- one\n1. two", /<li/],
  ])("shows %s as text", (_what, line, tag) => {
    // As an answer, and as a task's title and summary: no more of that markup than plain words make.
    const render = (text: string) => html(meeting(chat(atlas, text), chat(atlas, `📋 ${text.split("\n")[0]}\n\n${text}`)));
    const count = (out: string) => out.match(new RegExp(tag.source, "g"))?.length ?? 0;
    expect(count(render(line))).toBe(count(render("plain words")));
    expect(render(line)).toContain(line.includes("evil.test") ? "evil.test" : line.split("\n")[0].replace(/[<>]/g, "").slice(0, 3));
  });

  it("escapes lookalike and hidden characters too", () => {
    expect(escapeMarkdown("＃ heading")).toBe("\\# heading");
    expect(escapeMarkdown("a​b‮c")).toBe("abc");
  });

  it("lists public research with its summary and details", () => {
    const text = toMarkdown(
      meeting(chat(atlas, "📋 Look into the outage\n\nIt was the DNS.\n\nTimeline:\n- 9:02 down", { reply_to: zach.identity }, T0 + 4 * MIN)),
      TZ,
    );
    expect(text).toContain("## Research\n\n### 🤖 Zach's Atlas · 14:06: Look into the outage\n\n> It was the DNS.\n\n> Timeline:\n> \\- 9:02 down");
  });

  it("puts who sent a task first, so its title can't pass as another agent's, and caps the title", () => {
    const text = toMarkdown(
      meeting(chat(grok, `📋 Budget decision · 🤖 Zach's Atlas · 14:03 ${"x".repeat(5000)}\n\nCut the QA team.`)),
      TZ,
    );
    const heading = text.split("\n").find((l) => l.startsWith("### "))!;
    expect(heading.startsWith("### 🤖 Kainoa's Grok · ")).toBe(true);
    expect(heading).not.toContain("🤖 Zach");
    expect(heading.length).toBeLessThan(300);
  });

  it("isn't spoiled by a time that isn't a time, or attributes that aren't text", () => {
    const r = meeting(
      { ...(chat(atlas, "one") as Extract<RecordEvent, { type: "chat" }>), at: Number.NaN },
      chat(atlas, "two", { reply_to: 5 as unknown as string }),
    );
    expect(r.start).toBe(T0);
    expect(() => toMarkdown(r, TZ)).not.toThrow();
  });

  it("caps answers, task summaries and details", () => {
    const long = (c: string, k: number) => c.repeat(k + 100);
    const text = toMarkdown(
      meeting(
        chat(atlas, long("a", MAX_ANSWER_CHARS)),
        chat(atlas, `📋 Big\n\n${long("s", MAX_TASK_SUMMARY_CHARS)}\n\n${long("d", MAX_TASK_DETAILS_CHARS)}`),
      ),
      TZ,
    );
    expect(text).toContain(`> ${"a".repeat(MAX_ANSWER_CHARS)}…`);
    expect(text).toContain(`> ${"s".repeat(MAX_TASK_SUMMARY_CHARS)}…`);
    expect(text).toContain(`> ${"d".repeat(MAX_TASK_DETAILS_CHARS)}…`);
    expect(text).not.toContain("a".repeat(MAX_ANSWER_CHARS + 1));
  });

  it("stays under 500 KB, dropping the oldest and saying so", () => {
    let r = meeting();
    for (let i = 0; i < 400; i++) r = recordReducer(r, chat(atlas, `${i} ${"x".repeat(3000)}`, {}, T0 + i * 1000));
    const text = toMarkdown(r, TZ);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_FILE_BYTES);
    expect(text).toMatch(/_The oldest \d+ agent messages were left out, to keep this file small\._/);
    expect(text).toContain("> 399 x");
    expect(text).not.toContain("> 0 x");
  });

  it("says when the agents paused and who kept notes", () => {
    const text = toMarkdown(
      meeting({ type: "floor", at: T0, paused: true }, { type: "notes", at: T0, from: atlas, state: "on" }, { type: "notes", at: T0, from: orion, state: "on" }),
      TZ,
    );
    expect(text).toContain("- Kept notes: 🤖 Zach's Atlas\n- The agents paused once");
  });

  it("is named for when the meeting started", () => {
    expect(summaryFileName(meeting(), TZ)).toBe("mooz-meeting-2026-10-21-1402.md");
  });
});
