import { describe, expect, it } from "vitest";
import { addLine, resolveSenders, shownLines, type ChatLine } from "./chat-log";

interface Who {
  identity: string;
  name: string;
}

const zach: Who = { identity: "p_zach", name: "Zach" };
const grok: Who = { identity: "a_grok", name: "Grok" };

/** Who this tab knows of: Zach from the start; Grok only once LiveKit has announced it. */
const knowing = (...people: Who[]) => (identity: string) => people.find((p) => p.identity === identity);

let n = 0;
const line = (identity: string, message: string, id = `m${++n}`): ChatLine<Who> => ({ id, identity, message, timestamp: n });

describe("the chat log", () => {
  it("shows a line from someone this tab knows at once, as theirs", () => {
    const lines = addLine([], line(zach.identity, "@Grok what's 2+2?"), knowing(zach));
    expect(shownLines(lines).map((l) => [l.from.name, l.message])).toEqual([["Zach", "@Grok what's 2+2?"]]);
  });

  it("holds a line from someone LiveKit hasn't announced yet, then shows it as theirs, where it came", () => {
    let lines = addLine([], line(zach.identity, "@Grok what's 2+2?"), knowing(zach));
    lines = addLine(lines, line(grok.identity, "One sec, checking."), knowing(zach));
    lines = addLine(lines, line(zach.identity, "anyone?"), knowing(zach));
    // Never anyone else's meanwhile: not shown at all.
    expect(shownLines(lines).map((l) => l.message)).toEqual(["@Grok what's 2+2?", "anyone?"]);

    lines = resolveSenders(lines, knowing(zach, grok));
    expect(shownLines(lines).map((l) => [l.from.name, l.message])).toEqual([
      ["Zach", "@Grok what's 2+2?"],
      ["Grok", "One sec, checking."],
      ["Zach", "anyone?"],
    ]);
  });

  it("never shows a line from a sender this tab never comes to know, or from no sender at all", () => {
    let lines = addLine([], line("a_gone", "said, then left before anyone knew"), knowing(zach));
    lines = addLine(lines, line("", "from no participant"), knowing(zach));
    lines = resolveSenders(lines, knowing(zach, grok));
    expect(shownLines(lines)).toEqual([]);
    expect(lines.map((l) => l.message)).toEqual(["said, then left before anyone knew"]);
  });

  it("keeps a sender once known, after they leave", () => {
    let lines = addLine([], line(grok.identity, "Four."), knowing(grok));
    lines = resolveSenders(lines, knowing());
    expect(shownLines(lines).map((l) => l.from)).toEqual([grok]);
  });

  it("changes nothing when there's no one new to know", () => {
    const lines = addLine([], line(grok.identity, "Four."), knowing(zach));
    expect(resolveSenders(lines, knowing(zach))).toBe(lines);
  });

  it("replaces a line sent again (same sender and id) where it was, and no one else's", () => {
    let lines = addLine([], line(zach.identity, "first", "same"), knowing(zach, grok));
    lines = addLine(lines, line(grok.identity, "in between"), knowing(zach, grok));
    lines = addLine(lines, line(zach.identity, "first, edited", "same"), knowing(zach, grok));
    // Another participant reusing the id is another line: it can't overwrite Zach's.
    lines = addLine(lines, line(grok.identity, "not Zach's", "same"), knowing(zach, grok));
    expect(shownLines(lines).map((l) => [l.from.name, l.message])).toEqual([
      ["Zach", "first, edited"],
      ["Grok", "in between"],
      ["Grok", "not Zach's"],
    ]);
  });
});
