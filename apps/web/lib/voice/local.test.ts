import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalHearing,
  LocalVoiceOut,
  MAX_FAILURES,
  MAX_WAITING,
  REQUEST_TIMEOUT_MS,
  splitSentences,
  synthesizeLocal,
  testLocal,
  transcribeLocal,
} from "./local";
import { SCRIBE_RATE } from "./pcm";
import { VoiceError, parseLocalVoice, type LocalVoice } from "./settings";

const parsed = parseLocalVoice({ voice: "af_bella" });
if (typeof parsed === "string") throw new Error(parsed);
const LOCAL: LocalVoice = parsed;
const BASE = "http://127.0.0.1:3900/v1";
const ORIGIN = "https://mooz.example.com";

type Call = [string, RequestInit];
const calls = (f: ReturnType<typeof vi.fn>) => f.mock.calls as unknown as Call[];

function bytes(...values: number[]) {
  return new Response(new Uint8Array(values), { status: 200 });
}

/** A fetch that never answers, but gives up when its signal aborts (as the browser's does). */
function hanging(_url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  return [...new Uint8Array(await new Response(stream).arrayBuffer())];
}

afterEach(() => vi.useRealTimers());

describe("testLocal", () => {
  it("asks the server for its models, sending no key", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(testLocal(LOCAL, ORIGIN, fetchImpl)).resolves.toBeUndefined();
    const [[url, init]] = calls(fetchImpl);
    expect(url).toBe(`${BASE}/models`);
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBeUndefined();
  });

  it("counts a server without /models, but not one that turns the page away", async () => {
    await expect(testLocal(LOCAL, ORIGIN, async () => new Response("", { status: 404 }))).resolves.toBeUndefined();
    const refused = testLocal(LOCAL, ORIGIN, async () => new Response("", { status: 403 }));
    await expect(refused).rejects.toMatchObject({ fatal: true });
    await expect(refused).rejects.toThrow(ORIGIN);
  });

  it("tells a server that doesn't allow this page apart from one that isn't there", async () => {
    // The page's request fails (CORS), but a no-cors probe gets an (opaque) answer.
    const blocked = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.mode === "no-cors") return new Response(null, { status: 200 });
      throw new TypeError("Failed to fetch");
    });
    const notAllowed = testLocal(LOCAL, ORIGIN, blocked);
    await expect(notAllowed).rejects.toThrow(/OMNIVOICE_ALLOWED_ORIGINS/);
    await expect(notAllowed).rejects.toThrow(ORIGIN);
    expect(calls(blocked).map(([, init]) => init.mode)).toEqual([undefined, "no-cors"]);

    const gone = testLocal(LOCAL, ORIGIN, async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(gone).rejects.toThrow(`Can't reach your speech server at ${BASE}. Is it running?`);
    await expect(gone).rejects.toThrow(/allow it in the site settings/);
  });

  it("gives up on a server that never answers, without probing it", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(hanging);
    const result = testLocal(LOCAL, ORIGIN, fetchImpl);
    const caught = expect(result).rejects.toThrow(/took too long/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await caught;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("splitSentences", () => {
  it("splits on sentence ends, and keeps short pieces with the next", () => {
    expect(splitSentences("  ")).toEqual([]);
    expect(splitSentences("Yes?")).toEqual(["Yes?"]);
    expect(splitSentences("Hi. The build is green. Ship it!")).toEqual(["Hi. The build is green.", "Ship it!"]);
    expect(splitSentences("It's at 3.5 percent. Up from 2 last week.")).toEqual([
      "It's at 3.5 percent.",
      "Up from 2 last week.",
    ]);
  });
});

describe("synthesizeLocal", () => {
  it("speaks a sentence a request, asking for the next as soon as this one starts", async () => {
    const replies = [bytes(1, 2), bytes(3), bytes(4, 5)];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const stream = await synthesizeLocal(
      LOCAL,
      "The build is green again. Two tests were flaky. I've filed both.",
      undefined,
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const reader = stream.getReader();
    expect([...(await reader.read()).value!]).toEqual([1, 2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the next sentence, while this one plays
    const rest: number[] = [];
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest.push(...r.value);
    expect(rest).toEqual([3, 4, 5]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const [url, init] = calls(fetchImpl)[0];
    expect(url).toBe(`${BASE}/audio/speech`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(calls(fetchImpl).map(([, i]) => JSON.parse(i.body as string))).toEqual([
      { model: "tts-1", input: "The build is green again.", voice: "af_bella", response_format: "pcm" },
      { model: "tts-1", input: "Two tests were flaky.", voice: "af_bella", response_format: "pcm" },
      { model: "tts-1", input: "I've filed both.", voice: "af_bella", response_format: "pcm" },
    ]);
  });

  it("says nothing for nothing", async () => {
    const fetchImpl = vi.fn();
    expect(await readAll(await synthesizeLocal(LOCAL, " ", undefined, fetchImpl))).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops the voice for a setup that can't work, and not for a busy moment", async () => {
    const wrongVoice = synthesizeLocal(LOCAL, "Hello there.", undefined, async () => new Response("no voice 'af_bella'", { status: 422 }));
    await expect(wrongVoice).rejects.toMatchObject({ fatal: true });
    await expect(wrongVoice).rejects.toThrow("Your speech server couldn't speak (HTTP 422): no voice 'af_bella'");
    for (const status of [500, 503, 429, 408]) {
      await expect(
        synthesizeLocal(LOCAL, "Hello there.", undefined, async () => new Response("", { status })),
      ).rejects.toMatchObject({ fatal: false });
    }
    const offline = synthesizeLocal(LOCAL, "Hello there.", undefined, async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(offline).rejects.toBeInstanceOf(VoiceError);
    await expect(offline).rejects.toMatchObject({ fatal: false });
  });

  it("keeps a server's reply to one line, free of control characters", async () => {
    const noisy = synthesizeLocal(LOCAL, "Hello there.", undefined, async () =>
      new Response(`bad\n\u0007${"x".repeat(500)}`, { status: 400 }),
    );
    const error = (await noisy.catch((e: unknown) => e)) as VoiceError;
    expect(error.message).toMatch(/^Your speech server couldn't speak \(HTTP 400\): bad x+$/);
    expect(error.message.length).toBeLessThan(260);
  });

  it("lets a cancel through as itself", async () => {
    const abort = new AbortController();
    abort.abort();
    const aborted = new DOMException("aborted", "AbortError");
    await expect(synthesizeLocal(LOCAL, "Hello there.", abort.signal, () => Promise.reject(aborted))).rejects.toBe(aborted);
  });

  it("fails partway with the reason when a later sentence can't be made", async () => {
    const replies = [bytes(1), new Response("", { status: 500 })];
    const stream = await synthesizeLocal(LOCAL, "First sentence here. Second sentence here.", undefined, async () =>
      replies.shift()!,
    );
    const reader = stream.getReader();
    expect([...(await reader.read()).value!]).toEqual([1]);
    await expect(reader.read()).rejects.toThrow("Your speech server couldn't speak (HTTP 500).");
  });

  it("gives up on audio that stops coming", async () => {
    vi.useFakeTimers();
    const stream = await synthesizeLocal(LOCAL, "Hello there.", undefined, async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([9]));
          init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200 });
    });
    const reader = stream.getReader();
    expect([...(await reader.read()).value!]).toEqual([9]);
    const stalled = expect(reader.read()).rejects.toThrow(/took too long/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await stalled;
  });

  it("stops asking when the line is cut short", async () => {
    const cancelled: string[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      const id = `s${++n}`;
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => c.enqueue(new Uint8Array([n])),
          cancel: () => void cancelled.push(id),
        }),
        { status: 200 },
      );
    });
    const stream = await synthesizeLocal(LOCAL, "First sentence here. Second sentence here.", undefined, fetchImpl);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(cancelled.sort()).toEqual(["s1", "s2"]));
  });
});

describe("transcribeLocal", () => {
  const clip = (seconds: number) => new Int16Array(seconds * SCRIBE_RATE).fill(500);

  it("sends one utterance as a WAV, and returns what was said", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ text: "  Hey Grok, what's left?  " }));
    expect(await transcribeLocal(LOCAL, clip(2), undefined, fetchImpl)).toBe("Hey Grok, what's left?");
    const [[url, init]] = calls(fetchImpl);
    expect(url).toBe(`${BASE}/audio/transcriptions`);
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined(); // the browser sets the multipart boundary
    const form = init.body as FormData;
    expect(Object.fromEntries([...form.entries()].filter(([k]) => k !== "file"))).toEqual({
      model: "whisper-1",
      language: "en",
      response_format: "json",
      temperature: "0",
    });
    const file = form.get("file") as File;
    expect(file.name).toBe("speech.wav");
    expect(file.type).toBe("audio/wav");
    expect(file.size).toBe(44 + 2 * SCRIBE_RATE * 2);
  });

  it("drops what a model hears in a short burst of noise, but not in real speech", async () => {
    const reply = async () => Response.json({ text: "Thank you." });
    expect(await transcribeLocal(LOCAL, clip(1), undefined, reply)).toBe("");
    expect(await transcribeLocal(LOCAL, clip(2), undefined, reply)).toBe("Thank you.");
  });

  it("stops for a wrong address at once, and lets other failures count", async () => {
    const missing = transcribeLocal(LOCAL, clip(1), undefined, async () => new Response("Not Found", { status: 404 }));
    await expect(missing).rejects.toMatchObject({ fatal: true });
    await expect(transcribeLocal(LOCAL, clip(1), undefined, async () => new Response("", { status: 400 }))).rejects.toMatchObject({
      fatal: false,
    });
    await expect(transcribeLocal(LOCAL, clip(1), undefined, async () => new Response("<html>", { status: 200 }))).rejects.toThrow(
      /wasn't JSON/,
    );
    expect(await transcribeLocal(LOCAL, clip(1), undefined, async () => Response.json({}))).toBe("");
  });
});

describe("LocalHearing", () => {
  function setup(transcribe: (pcm: Int16Array, signal: AbortSignal) => Promise<string>) {
    const heard: [string, string][] = [];
    const fatal: string[] = [];
    const hearing = new LocalHearing(transcribe);
    const person = (who: string) =>
      hearing.person({ onText: (t) => heard.push([who, t]), onFatal: (m) => fatal.push(m) });
    return { hearing, person, heard, fatal };
  }
  const frame = (value: number) => new Int16Array(160).fill(value);

  it("holds a person's speech until they pause, then sends it as one utterance", async () => {
    const sent: number[][] = [];
    const { person, heard } = setup(async (pcm) => {
      sent.push([...new Set(pcm)]);
      return `heard ${pcm.length}`;
    });
    const ann = person("ann");
    ann.send(frame(1), false);
    ann.send(frame(2), false);
    expect(sent).toEqual([]);
    ann.send(frame(3), true, true);
    await vi.waitFor(() => expect(heard).toEqual([["ann", "heard 480"]]));
    expect(sent).toEqual([[1, 2, 3]]);

    // A cough isn't sent, and doesn't spill into what comes next.
    ann.send(frame(4), false);
    ann.send(frame(5), true, false);
    ann.send(frame(6), true, true);
    await vi.waitFor(() => expect(heard).toHaveLength(2));
    expect(sent[1]).toEqual([6]);
  });

  it("asks the server one at a time, keeps at most six waiting, and drops the oldest", async () => {
    const started: number[] = [];
    const finish: (() => void)[] = [];
    const { hearing, person, heard } = setup(
      (pcm) =>
        new Promise((resolve) => {
          started.push(pcm[0]);
          finish.push(() => resolve(`#${pcm[0]}`));
        }),
    );
    const bob = person("bob");
    for (let i = 1; i <= MAX_WAITING + 3; i++) bob.send(frame(i), true, true);
    await vi.waitFor(() => expect(started).toEqual([1]));
    expect(hearing.waitingCount).toBe(MAX_WAITING);
    for (let i = 0; i <= MAX_WAITING; i++) {
      finish[i]();
      await vi.waitFor(() => expect(heard).toHaveLength(i + 1));
    }
    // 2 and 3 were the oldest waiting when 8 and 9 came.
    expect(started).toEqual([1, 4, 5, 6, 7, 8, 9]);
  });

  it("forgets someone who left, even mid-request", async () => {
    let release: () => void = () => undefined;
    const { person, heard } = setup(
      () =>
        new Promise((resolve) => {
          release = () => resolve("too late");
        }),
    );
    const cy = person("cy");
    cy.send(frame(1), true, true);
    cy.send(frame(2), true, true);
    await vi.waitFor(() => expect(release).not.toBeUndefined());
    cy.close();
    release();
    cy.send(frame(3), true, true);
    await new Promise((r) => setTimeout(r, 10));
    expect(heard).toEqual([]);
  });

  it("stops after failures in a row, or at once for one that can't come right", async () => {
    let failures = 0;
    const flaky = setup(async () => {
      failures += 1;
      if (failures === 2) return "ok"; // resets the count
      throw new VoiceError("Can't reach your speech server.", false);
    });
    const dee = flaky.person("dee");
    for (let i = 0; i < MAX_FAILURES + 2; i++) dee.send(frame(i + 1), true, true);
    await vi.waitFor(() => expect(flaky.fatal).toEqual(["Can't reach your speech server."]));
    expect(failures).toBe(MAX_FAILURES + 2);
    dee.send(frame(9), true, true);
    expect(flaky.hearing.waitingCount).toBe(0);

    const wrong = setup(async () => {
      throw new VoiceError("Your speech server couldn't transcribe (HTTP 404).", true);
    });
    const eve = wrong.person("eve");
    eve.send(frame(1), true, true);
    eve.send(frame(2), true, true);
    await vi.waitFor(() => expect(wrong.fatal).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(wrong.fatal).toHaveLength(1);
  });

  it("cancels the request in flight when closed", async () => {
    let signal: AbortSignal | undefined;
    const { hearing, person, fatal } = setup((_pcm, s) => {
      signal = s;
      return new Promise((_, reject) => s.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    person("fay").send(frame(1), true, true);
    await vi.waitFor(() => expect(signal).toBeDefined());
    hearing.close();
    expect(signal!.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(fatal).toEqual([]);
  });
});

describe("LocalVoiceOut", () => {
  it("makes the fixed phrases once, then says them from memory", async () => {
    const fetchImpl = vi.fn(async () => bytes(7, 8));
    const voice = new LocalVoiceOut(LOCAL, fetchImpl);
    await voice.warm(["Yes?", "One sec, checking."]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await readAll(await voice.synthesize(" Yes? ", new AbortController().signal))).toEqual([7, 8]);
    expect(await readAll(await voice.synthesize("Yes?", new AbortController().signal))).toEqual([7, 8]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await readAll(await voice.synthesize("Something new.", new AbortController().signal))).toEqual([7, 8]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("makes a phrase when first said if warming failed, and stops warming when closed", async () => {
    const down = new LocalVoiceOut(LOCAL, async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(down.warm(["Yes?"])).resolves.toBeUndefined();
    await expect(down.synthesize("Yes?", new AbortController().signal)).rejects.toBeInstanceOf(VoiceError);

    const fetchImpl = vi.fn(hanging);
    const closing = new LocalVoiceOut(LOCAL, fetchImpl);
    const warming = closing.warm(["Yes?", "One sec, checking."]);
    closing.close();
    await warming;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
