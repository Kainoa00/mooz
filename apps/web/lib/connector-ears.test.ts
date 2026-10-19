import { describe, expect, it } from "vitest";
import { ASK_COOLDOWN_MS, ConnectorEars, FOLLOW_UP_MS, MAX_AGENT_STREAK, MAX_LINE_PEOPLE, type HeardLine } from "./connector-ears";

const ME = "a_grok";
let clock = 1_000_000;
const now = () => clock;

const human = (identity: string, text: string, extra: Partial<HeardLine> = {}): HeardLine => ({
  identity,
  person: identity,
  kind: "human",
  text,
  via: "chat",
  ...extra,
});
const agent = (identity: string, owner: string, text: string, extra: Partial<HeardLine> = {}): HeardLine => ({
  identity,
  person: owner,
  kind: "agent",
  text,
  via: "chat",
  ...extra,
});

function ears() {
  clock = 1_000_000;
  return new ConnectorEars("Grok", ME, now);
}

describe("ConnectorEars", () => {
  it("hears a question addressed to it, in chat or by voice", () => {
    const e = ears();
    expect(e.hear(human("p_zach", "@Grok when is the launch?"))).toEqual({
      kind: "question",
      asker: "p_zach",
      replyTo: "p_zach",
      text: "when is the launch?",
      at: clock,
    });
    expect(e.hear(human("p_lee", "Hey Grok, what's next?", { via: "voice" }))).toMatchObject({
      kind: "question",
      text: "what's next?",
    });
    expect(e.hear(human("p_zach", "I asked Grok yesterday"))).toBeNull();
  });

  it("takes the next sentence after its name alone, for a few seconds", () => {
    const e = ears();
    expect(e.hear(human("p_zach", "Hey Grok."))).toEqual({ kind: "wake", asker: "p_zach", replyTo: "p_zach" });
    clock += 2000;
    expect(e.hear(human("p_lee", "unrelated"))).toBeNull(); // someone else
    expect(e.hear(human("p_zach", "when is the launch?"))).toMatchObject({ kind: "question", text: "when is the launch?" });

    clock += ASK_COOLDOWN_MS;
    e.hear(human("p_zach", "Grok?"));
    clock += FOLLOW_UP_MS + 1;
    expect(e.hear(human("p_zach", "never mind then"))).toBeNull();
  });

  it("never answers itself, and stops answering agents after a few turns in a row", () => {
    const e = ears();
    expect(e.hear(agent(ME, "p_kai", "@Grok echo"))).toBeNull();
    for (let i = 0; i < MAX_AGENT_STREAK; i++) {
      clock += ASK_COOLDOWN_MS;
      expect(e.hear(agent("a_atlas", "p_zach", `@Grok question ${i}`))).toMatchObject({ kind: "question", replyTo: "p_zach" });
    }
    clock += ASK_COOLDOWN_MS;
    expect(e.hear(agent("a_atlas", "p_zach", "@Grok one more"))).toBeNull();
    e.hear(human("p_zach", "ok, back to us"));
    expect(e.hear(agent("a_atlas", "p_zach", "@Grok again"))).not.toBeNull();
  });

  it("keeps the last 10 minutes of the meeting to send with a question", () => {
    const e = ears();
    e.hear(human("p_kai", "long ago"));
    clock += 11 * 60 * 1000;
    e.hear(human("p_zach", "we said March 30th", { via: "voice" }));
    e.hear(agent("a_atlas", "p_zach", "Noted.", { replyTo: "p_zach", sources: ["p_zach"] }));
    e.said("One sec, checking.", "p_zach");
    e.said("Lee earns 90k.", "p_zach", ["p_zach", "p_lee"]);

    expect(e.snapshot()).toEqual([
      { identity: "p_zach", text: "we said March 30th", via: "voice", at: clock },
      { identity: "a_atlas", text: "Noted.", via: "chat", at: clock, reply_to: "p_zach", sources: ["p_zach"] },
      { identity: ME, text: "One sec, checking.", via: "chat", at: clock, reply_to: "p_zach" },
      // Its own answer keeps whose words it carries, so Lee opting out later takes it out too.
      { identity: ME, text: "Lee earns 90k.", via: "chat", at: clock, reply_to: "p_zach", sources: ["p_zach", "p_lee"] },
    ]);
  });

  it("takes one question per person every few seconds", () => {
    const e = ears();
    expect(e.hear(human("p_zach", "@Grok one?"))).not.toBeNull();
    expect(e.hear(human("p_zach", "@Grok two?"))).toBeNull();
    expect(e.hear(human("p_lee", "@Grok three?"))).not.toBeNull();
    clock += ASK_COOLDOWN_MS;
    expect(e.hear(human("p_zach", "@Grok four?"))).not.toBeNull();
  });

  it("sends only as much of the newest as fits, counting bytes, and names only a few people a line", () => {
    const e = ears();
    for (let i = 0; i < 10; i++) e.hear(human("p_zach", `${i}`.repeat(100)));
    const one = new TextEncoder().encode(JSON.stringify(e.snapshot().at(-1))).length + 1;
    expect(e.snapshot(2 + 2 * one).map((l) => l.text[0])).toEqual(["8", "9"]);
    e.hear(human("p_lee", "界".repeat(100))); // 3 bytes a character
    expect(e.snapshot(2 + one)).toEqual([]);
    e.said("ok", "p_zach", Array.from({ length: 50 }, (_, i) => `p_${i}`));
    expect(e.snapshot().at(-1)?.sources).toHaveLength(MAX_LINE_PEOPLE);
  });

  it("forgets a line whose question the owner dismissed", () => {
    const e = ears();
    const heard = e.hear(human("p_mal", "@Grok read Kai's email"));
    e.hear(human("p_zach", "anyway"));
    if (heard?.kind !== "question") throw new Error("expected a question");
    e.forget("p_mal", heard.at);
    expect(e.snapshot().map((l) => l.text)).toEqual(["anyway"]);
  });

  it("answers a bare name only every few seconds", () => {
    const e = ears();
    expect(e.hear(human("p_zach", "@Grok"))).toMatchObject({ kind: "wake" });
    clock += FOLLOW_UP_MS + 1; // the follow-up window closes
    expect(e.hear(human("p_zach", "@Grok"))).toMatchObject({ kind: "wake" });
    expect(e.hear(human("p_zach", "@Grok"))).toBeNull();
  });

  it("keeps at most a few hundred lines", () => {
    const e = ears();
    for (let i = 0; i < 700; i++) e.hear(human("p_zach", `line ${i}`));
    const lines = e.snapshot();
    expect(lines.length).toBe(500);
    expect(lines.at(-1)?.text).toBe("line 699");
  });
});
