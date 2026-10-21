import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceError } from "./settings";
import {
  IDLE_CLOSE_MS,
  MAX_FAILURES,
  MAX_QUEUED_SAMPLES,
  RETRY_DELAYS_MS,
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
