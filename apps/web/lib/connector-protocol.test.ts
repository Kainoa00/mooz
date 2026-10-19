import { describe, expect, it } from "vitest";
import {
  APP_LABEL,
  SPOKEN_LIMIT,
  assistantLink,
  assistantPrompt,
  parseAnswerPacket,
  setupSteps,
  splitPastedAnswer,
} from "./connector-protocol";

const packet = (over: Record<string, unknown> = {}) => ({
  type: "answer",
  id: "q_abc",
  spoken: "March 30th.",
  details: "From the plan.",
  reply_to: "p_zach",
  sources: ["p_zach", "p_kai"],
  ...over,
});

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

describe("parseAnswerPacket", () => {
  it("reads an answer the server sent", () => {
    expect(parseAnswerPacket(bytes(packet()))).toEqual(packet());
  });

  it("rejects anything malformed", () => {
    for (const bad of [
      "{nope",
      [1],
      packet({ type: "task" }),
      packet({ id: 5 }),
      packet({ spoken: "" }),
      packet({ spoken: 3 }),
      packet({ reply_to: null }),
      packet({ sources: "p_zach" }),
      packet({ sources: [1] }),
    ]) {
      expect(parseAnswerPacket(bytes(bad))).toBeNull();
    }
  });

  it("caps what it keeps and fills in missing details", () => {
    const parsed = parseAnswerPacket(
      bytes(packet({ spoken: "x".repeat(1000), details: undefined, sources: Array(300).fill("p_x") })),
    )!;
    expect(parsed.spoken.length).toBeLessThanOrEqual(400);
    expect(parsed.details).toBe("");
    expect(parsed.sources.length).toBe(200);
  });
});

describe("one tap to the assistant", () => {
  it("asks the assistant to use the connector, without the meeting's words in the link", () => {
    const prompt = assistantPrompt("q_abc");
    expect(prompt).toContain("q_abc");
    expect(prompt).toContain("get_question");
    expect(prompt).toContain("post_answer");
  });

  it("opens each app with the prompt filled in", () => {
    const prompt = assistantPrompt("q_abc");
    const enc = encodeURIComponent(prompt);
    expect(assistantLink("grok", prompt)).toBe(`https://grok.com/?q=${enc}`);
    expect(assistantLink("claude", prompt)).toBe(`https://claude.ai/new?q=${enc}`);
    expect(assistantLink("chatgpt", prompt)).toBe(`https://chatgpt.com/?q=${enc}`);
    expect(assistantLink("other", prompt)).toBeNull();
  });

  it("names the apps and explains their setup", () => {
    expect(APP_LABEL.chatgpt).toBe("ChatGPT");
    for (const app of ["grok", "claude", "chatgpt", "other"] as const) {
      expect(setupSteps(app).length).toBeGreaterThan(1);
    }
    expect(setupSteps("chatgpt").join(" ")).toMatch(/developer mode/i);
  });
});

describe("splitPastedAnswer", () => {
  it("speaks a short answer whole", () => {
    expect(splitPastedAnswer("  March 30th.  ")).toEqual({ spoken: "March 30th." });
  });

  it("speaks the first sentences of a long one and posts the rest, losing nothing", () => {
    const rest = "Here is the long part. ".repeat(40).trim();
    const out = splitPastedAnswer(`It moved to March 30th. QA needs a week. ${rest}`);
    expect(out.spoken.startsWith("It moved to March 30th. QA needs a week.")).toBe(true);
    expect(out.spoken.length).toBeLessThanOrEqual(SPOKEN_LIMIT);
    expect(`${out.spoken} ${out.details}`.replace(/\s+/g, " ")).toBe(`It moved to March 30th. QA needs a week. ${rest}`);
  });

  it("keeps the rest as it was written, paragraphs and all", () => {
    const rest = "First paragraph of detail goes on. ".repeat(8).trim() + "\n\n" + "Second paragraph. ".repeat(8).trim();
    const out = splitPastedAnswer(`March 30th. ${rest}`);
    expect(out.spoken.startsWith("March 30th.")).toBe(true);
    expect(out.details).toContain("\n\nSecond paragraph.");
    expect(rest.endsWith(out.details!)).toBe(true);
  });

  it("says the start of one endless sentence and posts all of it", () => {
    const long = "word ".repeat(200).trim();
    const out = splitPastedAnswer(long);
    expect(out.spoken.length).toBeLessThanOrEqual(SPOKEN_LIMIT);
    expect(out.spoken.endsWith("…")).toBe(true);
    expect(out.details).toBe(long);
  });
});
