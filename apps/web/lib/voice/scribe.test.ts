import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceError } from "./elevenlabs";
import {
  IDLE_CLOSE_MS,
  MAX_FAILURES,
  MAX_QUEUED_SAMPLES,
  MAX_STREAMS,
  RETRY_DELAYS_MS,
  ScribeHub,
  ScribeStream,
  type ScribeOptions,
  type SocketLike,
} from "./scribe";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: { message_type: string; audio_base_64: string; commit: boolean; sample_rate: number }[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  server(msg: Record<string, unknown> | string) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  start() {
    this.readyState = 1;
    this.server({ message_type: "session_started", session_id: "s1", config: {} });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const pcm = (n = 160, value = 1000) => new Int16Array(n).fill(value);
const flush = () => vi.advanceTimersByTimeAsync(0);
const last = () => FakeSocket.all.at(-1)!;

function stream(over: Partial<ScribeOptions> = {}) {
  const heard: string[] = [];
  const fatal: string[] = [];
  let tokens = 0;
  const s = new ScribeStream({
    token: async () => `sutkn_${++tokens}`,
    url: (token) => `wss://scribe.test/?token=${token}`,
    connect: (url) => new FakeSocket(url),
    onText: (t) => heard.push(t),
    onFatal: (m) => fatal.push(m),
    ...over,
  });
  return { s, heard, fatal };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
});
afterEach(() => vi.useRealTimers());

describe("ScribeStream", () => {
  it("connects on the first audio, with a fresh token, and sends what was said meanwhile", async () => {
    const { s, heard } = stream();
    expect(FakeSocket.all).toHaveLength(0);
    s.send(pcm(), false);
    s.send(pcm(), true);
    await flush();
    expect(last().url).toBe("wss://scribe.test/?token=sutkn_1");
    expect(last().sent).toHaveLength(0); // nothing until the session starts
    last().start();
    expect(last().sent.map((m) => [m.message_type, m.commit, m.sample_rate])).toEqual([
      ["input_audio_chunk", false, 16000],
      ["input_audio_chunk", true, 16000],
    ]);
    s.send(pcm(2), false);
    expect(atob(last().sent[2].audio_base_64)).toBe("\xe8\x03\xe8\x03");

    last().server({ message_type: "partial_transcript", text: "hey gr" });
    last().server({ message_type: "committed_transcript", text: " Hey Grok, what's next? " });
    last().server({ message_type: "committed_transcript", text: "  " });
    last().server("{not json");
    last().onmessage?.({ data: new ArrayBuffer(2) });
    expect(heard).toEqual(["Hey Grok, what's next?"]);
  });

  it("closes after a quiet spell and reopens with a new token on the next word", async () => {
    const { s } = stream();
    s.send(pcm(), true);
    await flush();
    last().start();
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 1);
    expect(last().readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(last().readyState).toBe(3);
    expect(s.status).toBe("idle");

    s.send(pcm(), false);
    await flush();
    expect(FakeSocket.all).toHaveLength(2);
    expect(last().url).toContain("sutkn_2");
  });

  it("keeps talking from closing it, and reconnects at once when the server ends a working session", async () => {
    const { s } = stream();
    s.send(pcm(), true);
    await flush();
    last().start();
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 10);
    s.send(pcm(), false); // talking again
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS);
    expect(last().readyState).toBe(1);

    last().server({ message_type: "session_time_limit_exceeded", error: "limit" });
    last().drop();
    expect(s.status).toBe("idle");
    s.send(pcm(), false);
    await flush();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("backs off when it can't connect, keeping only the last few seconds of audio", async () => {
    const { s } = stream();
    s.send(pcm(), false);
    await flush();
    last().drop(); // closed before the session started
    expect(FakeSocket.all).toHaveLength(1);
    for (let i = 0; i < 120; i++) s.send(pcm(1600), false); // 12 s while waiting
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] - 1);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(2);
    last().start();
    const samples = last().sent.reduce((n, m) => n + atob(m.audio_base_64).length / 2, 0);
    expect(samples).toBeLessThanOrEqual(MAX_QUEUED_SAMPLES);
    expect(samples).toBeGreaterThan(MAX_QUEUED_SAMPLES - 1600);
  });

  it("retries a token hiccup, but stops for good on a bad key", async () => {
    let calls = 0;
    const flaky = stream({
      token: async () => {
        calls += 1;
        if (calls === 1) throw new VoiceError("busy", false);
        return "sutkn_ok";
      },
    });
    flaky.s.send(pcm(), false);
    await flush();
    expect(FakeSocket.all).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(last().url).toContain("sutkn_ok");

    const bad = stream({ token: () => Promise.reject(new VoiceError("bad key", true)) });
    bad.s.send(pcm(), false);
    await flush();
    expect(bad.fatal).toEqual(["bad key"]);
    expect(bad.s.status).toBe("dead");
    bad.s.send(pcm(), false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bad.fatal).toHaveLength(1);
  });

  it("stops for good when Scribe refuses the account", async () => {
    const { s, fatal } = stream();
    s.send(pcm(), false);
    await flush();
    last().start();
    last().server({ message_type: "quota_exceeded", error: "no credits" });
    expect(fatal).toEqual(["Your ElevenLabs account is out of credits."]);
    expect(last().readyState).toBe(3);
    last().drop();
    expect(s.status).toBe("dead");
  });

  it("gives up after failing for a long time", async () => {
    const { s, fatal } = stream({
      connect: () => {
        throw new Error("blocked");
      },
    });
    s.send(pcm(), false);
    await vi.advanceTimersByTimeAsync(MAX_FAILURES * 30_000 + 1000);
    expect(fatal).toEqual(["Couldn't keep listening through ElevenLabs."]);
  });

  it("does nothing more once closed", async () => {
    const { s } = stream();
    s.send(pcm(), false);
    s.close();
    await flush();
    expect(FakeSocket.all).toHaveLength(0);
    s.send(pcm(), false);
    await flush();
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe("ScribeHub", () => {
  function hub() {
    const heard: [string, string][] = [];
    const fatal: string[] = [];
    const made: { s: ScribeStream; onFatal: (m: string) => void }[] = [];
    const h = new ScribeHub(
      48_000,
      (callbacks) => {
        const s = new ScribeStream({
          token: async () => "sutkn",
          url: () => "wss://scribe.test/",
          connect: (url) => new FakeSocket(url),
          ...callbacks,
        });
        made.push({ s, onFatal: callbacks.onFatal });
        return s;
      },
      (identity, text) => heard.push([identity, text]),
      (m) => fatal.push(m),
    );
    return { h, heard, fatal, made };
  }

  it("transcribes at most six people, each in their own stream, named by their track", async () => {
    const { h, heard } = hub();
    const tracks = Array.from({ length: 8 }, (_, i) => ({ key: `t${i}`, identity: `p_${i}` }));
    expect(h.sync(tracks)).toEqual(tracks.slice(0, MAX_STREAMS).map((t) => t.key));

    const speech = new Float32Array(4800).fill(0.2); // 100 ms at 48 kHz
    h.feed("t1", speech);
    h.feed("t7", speech); // over the cap: ignored
    await flush();
    expect(FakeSocket.all).toHaveLength(1);
    last().start();
    expect(last().sent[0].audio_base_64.length).toBeGreaterThan(0);
    last().server({ message_type: "committed_transcript", text: "Hey Grok" });
    expect(heard).toEqual([["p_1", "Hey Grok"]]);

    // Someone leaves: their stream closes and the next person gets a slot.
    expect(h.sync(tracks.filter((t) => t.key !== "t1"))).toContain("t6");
    expect(last().readyState).toBe(3);
  });

  it("stays quiet in silence, and commits when someone stops talking", async () => {
    const { h } = hub();
    h.sync([{ key: "t0", identity: "p_0" }]);
    for (let i = 0; i < 10; i++) h.feed("t0", new Float32Array(4800));
    await flush();
    expect(FakeSocket.all).toHaveLength(0);
    h.feed("t0", new Float32Array(4800).fill(0.2));
    await flush();
    last().start();
    for (let i = 0; i < 20; i++) h.feed("t0", new Float32Array(4800));
    expect(last().sent.filter((m) => m.commit)).toHaveLength(1);
  });

  it("stops everyone's transcription when the account can't be used", () => {
    const { h, fatal, made } = hub();
    expect(h.sync([{ key: "a", identity: "p_a" }, { key: "b", identity: "p_b" }])).toHaveLength(2);
    made[0].onFatal("bad key");
    made[1].onFatal("bad key");
    expect(fatal).toEqual(["bad key"]);
    expect(made.every((m) => m.s.status === "dead")).toBe(true);
    expect(h.sync([{ key: "c", identity: "p_c" }])).toEqual([]);
    h.feed("a", new Float32Array(10));
  });
});
