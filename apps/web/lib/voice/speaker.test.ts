import { describe, expect, it, vi } from "vitest";
import { TTS_RATE, VoiceError } from "./elevenlabs";
import { AgentSpeaker, LEAD_SECONDS, MAX_WAITING, type AudioOut } from "./speaker";

function fakeOut() {
  const started: { at: number; samples: number }[] = [];
  const stopped: number[] = [];
  const out: AudioOut & { currentTime: number } = {
    currentTime: 10,
    createBuffer: (_channels, length) => ({ length, copyToChannel: () => undefined }),
    createBufferSource() {
      const source = {
        buffer: null as unknown,
        connect: () => undefined,
        start: (at: number) => started.push({ at, samples: (source.buffer as { length: number }).length }),
        stop: () => stopped.push(1),
      };
      return source;
    },
  };
  return { out, started, stopped };
}

/** A TTS stream that yields the given byte chunks, then waits for `release` if given. */
function pcmStream(chunks: number[][], release?: Promise<void>) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      if (release) await release;
      controller.close();
    },
  });
}

const second = (n: number) => Array.from({ length: n * 2 }, () => 0); // n samples of silence

describe("AgentSpeaker", () => {
  it("plays each chunk right after the one before, a moment from now", async () => {
    const { out, started } = fakeOut();
    const waits: number[] = [];
    const speaker = new AgentSpeaker({
      out,
      destination: {},
      synthesize: async () => pcmStream([second(2400), [0], [0, 0, 0], []]),
      onError: () => undefined,
      wait: async (ms) => void waits.push(ms),
    });
    speaker.speak("March 30th.");
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    expect(started[0]).toEqual({ at: 10 + LEAD_SECONDS, samples: 2400 });
    expect(started[1].at).toBeCloseTo(10 + LEAD_SECONDS + 2400 / TTS_RATE, 9);
    expect(started[1].samples).toBe(2); // the split sample was put back together
    expect(waits[0]).toBeCloseTo((LEAD_SECONDS + 2402 / TTS_RATE) * 1000, 6);
  });

  it("never leaves a gap when the next chunk arrives just before the last one ends", async () => {
    const { out, started } = fakeOut();
    const chunk = second(2400); // 0.1 s at 24 kHz
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n === 1) out.currentTime = 10 + LEAD_SECONDS + 0.09; // the first chunk is nearly done
        if (n === 2) controller.close();
        else controller.enqueue(new Uint8Array(chunk));
        n += 1;
      },
    });
    const speaker = new AgentSpeaker({ out, destination: {}, synthesize: async () => stream, onError: () => undefined, wait: async () => undefined });
    speaker.speak("two chunks");
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started[1].at).toBeCloseTo(started[0].at + 0.1, 9);
  });

  it("speaks one answer at a time, and drops extras past a few", async () => {
    const { out } = fakeOut();
    let release!: () => void;
    const asked: string[] = [];
    const speaker = new AgentSpeaker({
      out,
      destination: {},
      synthesize: async (text) => {
        asked.push(text);
        return pcmStream([second(10)], asked.length === 1 ? new Promise<void>((r) => (release = r)) : undefined);
      },
      onError: () => undefined,
      wait: async () => undefined,
    });
    speaker.speak("one");
    speaker.speak("  ");
    for (let i = 0; i < MAX_WAITING + 2; i++) speaker.speak(`more ${i}`);
    await vi.waitFor(() => expect(asked).toEqual(["one"]));
    release();
    await vi.waitFor(() => expect(asked).toHaveLength(1 + MAX_WAITING));
    expect(asked.slice(1)).toEqual(["more 0", "more 1", "more 2"]);
  });

  it("reports failures; a bad key ends its voice, a hiccup only skips that answer", async () => {
    const { out } = fakeOut();
    const errors: VoiceError[] = [];
    const attempts: string[] = [];
    const speaker = new AgentSpeaker({
      out,
      destination: {},
      synthesize: async (text) => {
        attempts.push(text);
        if (text === "hiccup") throw new VoiceError("busy", false);
        if (text === "bad") throw new VoiceError("bad key", true);
        throw new Error("boom");
      },
      onError: (e) => errors.push(e),
      wait: async () => undefined,
    });
    speaker.speak("hiccup");
    speaker.speak("odd");
    speaker.speak("bad");
    await vi.waitFor(() => expect(errors).toHaveLength(3));
    expect(errors.map((e) => [e.message, e.fatal])).toEqual([
      ["busy", false],
      ["Your agent's voice stopped partway.", false],
      ["bad key", true],
    ]);
    speaker.speak("after");
    await new Promise((r) => setTimeout(r, 10));
    expect(attempts).toEqual(["hiccup", "odd", "bad"]);
  });

  it("stops talking at once when closed", async () => {
    const { out, stopped } = fakeOut();
    let signal!: AbortSignal;
    let release!: () => void;
    const errors: VoiceError[] = [];
    const speaker = new AgentSpeaker({
      out,
      destination: {},
      synthesize: async (_text, s) => {
        signal = s;
        return pcmStream([second(10)], new Promise<void>((r) => (release = r)));
      },
      onError: (e) => errors.push(e),
      wait: async () => undefined,
    });
    speaker.speak("long answer");
    speaker.speak("next");
    await vi.waitFor(() => expect(release).toBeDefined());
    await new Promise((r) => setTimeout(r, 0));
    speaker.close();
    expect(signal.aborted).toBe(true);
    expect(stopped).toHaveLength(1);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual([]);
  });
});
