import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HANGOVER_MS, LOCAL_GATE, PRE_ROLL_MS, SCRIBE_GATE, SpeechGate } from "./gate";
import { SCRIBE_RATE } from "./pcm";

const FRAME = 1600; // 100 ms at 16 kHz
const quiet = () => new Int16Array(FRAME).fill(20);
const loud = () => new Int16Array(FRAME).fill(3000);
const frames = (ms: number) => Math.round(((ms / 1000) * SCRIBE_RATE) / FRAME);

describe("SpeechGate", () => {
  it("sends nothing while it's quiet", () => {
    const gate = new SpeechGate();
    for (let i = 0; i < 50; i++) expect(gate.push(quiet())).toEqual({ frames: [], commit: false });
  });

  it("opens on speech with the moments just before it", () => {
    const gate = new SpeechGate();
    for (let i = 0; i < 20; i++) gate.push(quiet());
    const opened = gate.push(loud());
    expect(opened.commit).toBe(false);
    expect(opened.frames.length).toBe(frames(PRE_ROLL_MS) + 1);
    expect(opened.frames.at(-1)![0]).toBe(3000);
    expect(gate.push(loud()).frames.length).toBe(1);
  });

  it("keeps sending through short pauses, then commits once it's been quiet a while", () => {
    const gate = new SpeechGate();
    gate.push(loud());
    for (let i = 0; i < frames(HANGOVER_MS) - 2; i++) expect(gate.push(quiet())).toEqual({ frames: [quiet()], commit: false });
    gate.push(loud()); // talking again resets the wait
    const sent: boolean[] = [];
    for (let i = 0; i < frames(HANGOVER_MS); i++) sent.push(gate.push(quiet()).commit);
    expect(sent.filter(Boolean)).toHaveLength(1);
    expect(sent.at(-1)).toBe(true);
    expect(gate.push(quiet())).toEqual({ frames: [], commit: false });
  });
});

// The cases both gates run (bridge/tests/gate_cases.json), so the bridge and the tab cut speech alike.
interface GateCase {
  name: string;
  gate: "scribe" | "local";
  input: ["q" | "l", number][];
  events: { at: number | [number, number]; sent: number; commit?: boolean; keep?: boolean }[];
}
const shared = JSON.parse(
  readFileSync(new URL("../../../../bridge/tests/gate_cases.json", import.meta.url), "utf8"),
) as { frame_ms: number; cases: GateCase[] };

describe("shared gate cases", () => {
  it.each(shared.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const gate = new SpeechGate(c.gate === "local" ? LOCAL_GATE : SCRIBE_GATE);
    const size = (shared.frame_ms / 1000) * SCRIBE_RATE;
    const expected = new Map<number, { sent: number; commit: boolean; keep?: boolean }>();
    for (const e of c.events) {
      const [from, to] = Array.isArray(e.at) ? e.at : [e.at, e.at];
      for (let i = from; i <= to; i++) {
        expected.set(i, { sent: e.sent, commit: e.commit ?? false, ...(e.commit ? { keep: e.keep } : {}) });
      }
    }
    let i = 0;
    for (const [level, count] of c.input) {
      for (let n = 0; n < count; n++, i++) {
        const out = gate.push(new Int16Array(size).fill(level === "l" ? 3000 : 20));
        const want = expected.get(i) ?? { sent: 0, commit: false };
        expect({ at: i, sent: out.frames.length, commit: out.commit, ...(out.commit ? { keep: out.keep } : {}) }).toEqual({
          at: i,
          ...want,
        });
      }
    }
  });
});
