import { describe, expect, it } from "vitest";
import { LOCAL_GATE } from "./gate";
import { HearingHub, MAX_STREAMS, type Transcriber, type TranscriberCallbacks } from "./hearing";

class FakeTranscriber implements Transcriber {
  sent: { samples: number; commit: boolean; keep?: boolean }[] = [];
  closed = false;
  constructor(readonly callbacks: TranscriberCallbacks) {}
  send(pcm: Int16Array, commit: boolean, keep?: boolean) {
    this.sent.push({ samples: pcm.length, commit, keep });
  }
  close() {
    this.closed = true;
  }
}

const SPEECH = new Float32Array(4800).fill(0.2); // 100 ms at 48 kHz
const QUIET = new Float32Array(4800);

function hub(gate = LOCAL_GATE) {
  const heard: [string, string][] = [];
  const fatal: string[] = [];
  const made: FakeTranscriber[] = [];
  const h = new HearingHub(
    48_000,
    (callbacks) => {
      const t = new FakeTranscriber(callbacks);
      made.push(t);
      return t;
    },
    (identity, text) => heard.push([identity, text]),
    (m) => fatal.push(m),
    gate,
  );
  return { h, heard, fatal, made };
}

describe("HearingHub", () => {
  it("transcribes at most six people, each on their own, named by their track", () => {
    const { h, heard, made } = hub();
    const tracks = Array.from({ length: 8 }, (_, i) => ({ key: `t${i}`, identity: `p_${i}` }));
    expect(h.sync(tracks)).toEqual(tracks.slice(0, MAX_STREAMS).map((t) => t.key));
    expect(made).toHaveLength(MAX_STREAMS);

    h.feed("t1", SPEECH);
    h.feed("t7", SPEECH); // over the cap: ignored
    expect(made[1].sent).toEqual([{ samples: 1600, commit: false, keep: undefined }]);
    made[1].callbacks.onText("Hey Grok");
    expect(heard).toEqual([["p_1", "Hey Grok"]]);

    // Someone leaves: theirs closes and the next person gets a slot.
    expect(h.sync(tracks.filter((t) => t.key !== "t1"))).toContain("t6");
    expect(made[1].closed).toBe(true);
  });

  it("stays quiet in silence, and commits when someone stops talking, saying whether to keep it", () => {
    const { h, made } = hub();
    h.sync([{ key: "t0", identity: "p_0" }]);
    for (let i = 0; i < 10; i++) h.feed("t0", QUIET);
    expect(made[0].sent).toEqual([]);

    // A cough: 100 ms of sound is less speech than is worth transcribing.
    h.feed("t0", SPEECH);
    for (let i = 0; i < 7; i++) h.feed("t0", QUIET);
    expect(made[0].sent.filter((s) => s.commit)).toEqual([{ samples: 1600, commit: true, keep: false }]);

    // Talking for a while is kept.
    made[0].sent = [];
    for (let i = 0; i < 5; i++) h.feed("t0", SPEECH);
    for (let i = 0; i < 7; i++) h.feed("t0", QUIET);
    expect(made[0].sent.filter((s) => s.commit)).toEqual([{ samples: 1600, commit: true, keep: true }]);
    expect(made[0].sent.filter((s) => !s.commit).every((s) => s.keep === undefined)).toBe(true);
  });

  it("stops everyone's hearing once when it can't go on", () => {
    const { h, fatal, made } = hub();
    expect(h.sync([{ key: "a", identity: "p_a" }, { key: "b", identity: "p_b" }])).toHaveLength(2);
    made[0].callbacks.onFatal("no server");
    made[1].callbacks.onFatal("no server");
    expect(fatal).toEqual(["no server"]);
    expect(made.every((t) => t.closed)).toBe(true);
    expect(h.sync([{ key: "c", identity: "p_c" }])).toEqual([]);
    h.feed("a", SPEECH);
    h.close();
  });
});
