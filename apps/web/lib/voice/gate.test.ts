import { describe, expect, it } from "vitest";
import { HANGOVER_MS, PRE_ROLL_MS, SpeechGate } from "./gate";
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
