import { describe, expect, it } from "vitest";
import { APP_LABEL, assistantLink, assistantPrompt, parseAnswerPacket, setupSteps } from "./connector-protocol";

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
      bytes(packet({ spoken: "x".repeat(1000), details: undefined, sources: Array(100).fill("p_x") })),
    )!;
    expect(parsed.spoken.length).toBeLessThanOrEqual(400);
    expect(parsed.details).toBe("");
    expect(parsed.sources.length).toBeLessThanOrEqual(50);
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
