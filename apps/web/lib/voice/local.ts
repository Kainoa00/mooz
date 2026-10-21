import type { Transcriber, TranscriberCallbacks } from "./hearing";
import { SCRIBE_RATE, wavBytes } from "./pcm";
import { VoiceError, type LocalVoice } from "./settings";

/**
 * A speech server on the owner's computer (VoiceStudio, or another OpenAI-compatible one),
 * used straight from their browser. Nothing goes to mooz, and no key is needed or sent.
 */

export const LANGUAGE = "en";
/** Utterances waiting for the speech server, across everyone this tab hears; past this the oldest goes. */
export const MAX_WAITING = 6;
/** Failed transcriptions in a row before hearing stops (the server is gone, or can't do it). */
export const MAX_FAILURES = 5;
/** A request (and, when speaking, its audio) gets this long; a server on a CPU can be slow. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Shorter sentences go with the next one: a request each would only add gaps (as in the bridge). */
export const MIN_SENTENCE_CHARS = 12;
// Whisper-style models "hear" these in silence and noise. On a short clip, they're dropped (as in the bridge).
const SILENCE_PHRASES = new Set([
  "thank you",
  "thanks",
  "thank you very much",
  "thanks for watching",
  "thank you for watching",
  "you",
  "bye",
  "bye bye",
  "okay",
  "so",
  "hmm",
  "uh",
  "um",
]);
const SILENCE_CLIP_SECONDS = 1.5;
const DETAIL_CHARS = 200;

type Fetch = typeof fetch;

/** Nothing answered (as far as this page can tell). */
class Unreachable extends VoiceError {
  constructor(settings: LocalVoice) {
    super(
      `Can't reach your speech server at ${settings.baseUrl}. Is it running? If your browser asked about apps on this device, allow it in the site settings.`,
      false,
    );
  }
}

async function refused(res: Response, what: string, fatal: boolean): Promise<VoiceError> {
  const detail = (await res.text().catch(() => ""))
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim()
    .slice(0, DETAIL_CHARS);
  return new VoiceError(`Your speech server couldn't ${what} (HTTP ${res.status})${detail ? `: ${detail}` : "."}`, fatal);
}

interface Pending {
  res: Response;
  /** Call once the response's body is read (or given up on): ends its time limit. */
  done: () => void;
  /** What went wrong, for the owner, when this request (or reading its body) fails. */
  explain: (err: unknown) => unknown;
}

/** A request to the speech server with a time limit that also covers reading the body. */
async function request(
  fetchImpl: Fetch,
  settings: LocalVoice,
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Pending> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const follow = () => controller.abort();
  signal?.addEventListener("abort", follow, { once: true });
  if (signal?.aborted) controller.abort();
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", follow);
  };
  const explain = (err: unknown): unknown => {
    if (signal?.aborted || err instanceof VoiceError) return err;
    if (timedOut) return new VoiceError(`Your speech server at ${settings.baseUrl} took too long to answer.`, false);
    return new Unreachable(settings);
  };
  try {
    const res = await fetchImpl(`${settings.baseUrl}${path}`, { ...init, signal: controller.signal });
    return { res, done, explain };
  } catch (err) {
    done();
    throw explain(err);
  }
}

/**
 * Checks the speech server before voice goes on: it's there, and it lets this page in. When
 * the request fails, a no-cors probe tells "nothing there" from "there, but this page isn't
 * allowed" (the browser hides which from the page otherwise).
 */
export async function testLocal(settings: LocalVoice, origin: string, fetchImpl: Fetch = fetch): Promise<void> {
  let pending: Pending;
  try {
    pending = await request(fetchImpl, settings, "/models", {});
  } catch (err) {
    if (!(err instanceof Unreachable)) throw err;
    const answered = await request(fetchImpl, settings, "/models", { mode: "no-cors" }).then(
      (probe) => {
        probe.done();
        return true;
      },
      () => false,
    );
    if (!answered) throw err;
    throw new VoiceError(
      `Your speech server is running but doesn't let this page in. Add ${origin} to its allowed origins (OMNIVOICE_ALLOWED_ORIGINS for VoiceStudio) and restart it.`,
      true,
    );
  }
  const { res, done } = pending;
  done();
  void res.body?.cancel().catch(() => undefined);
  // A server without /models still counts (as in the bridge); one that turns the page away doesn't.
  if (res.status === 401 || res.status === 403) {
    throw new VoiceError(
      `Your speech server turned this page away (HTTP ${res.status}). Run it without a key, and with ${origin} in its allowed origins.`,
      true,
    );
  }
}

/** Sentences to speak one request each, so the first is heard while the rest are made. */
export function splitSentences(text: string): string[] {
  const pieces = text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const sentences: string[] = [];
  let carry = "";
  for (const piece of pieces) {
    const sentence = carry ? `${carry} ${piece}` : piece;
    if (sentence.length < MIN_SENTENCE_CHARS) {
      carry = sentence;
      continue;
    }
    sentences.push(sentence);
    carry = "";
  }
  if (carry) sentences.push(carry);
  return sentences;
}

interface Speech extends Omit<Pending, "res"> {
  reader: ReadableStreamDefaultReader<Uint8Array>;
}

async function speakOne(fetchImpl: Fetch, settings: LocalVoice, sentence: string, signal?: AbortSignal): Promise<Speech> {
  const { res, done, explain } = await request(
    fetchImpl,
    settings,
    "/audio/speech",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: settings.ttsModel, input: sentence, voice: settings.voice, response_format: "pcm" }),
    },
    signal,
  );
  if (!res.ok || !res.body) {
    // A busy or broken server may recover; a wrong address, model or voice won't (and every line would fail).
    const error = await refused(res, "speak", res.status < 500 && res.status !== 408 && res.status !== 429);
    done();
    throw error;
  }
  return { reader: res.body.getReader(), done, explain };
}

/**
 * Streams spoken audio for `text` as 24 kHz 16-bit PCM bytes (OpenAI's "pcm"): a sentence
 * per request, the next one asked for as soon as this one starts coming.
 */
export async function synthesizeLocal(
  settings: LocalVoice,
  text: string,
  signal?: AbortSignal,
  fetchImpl: Fetch = fetch,
): Promise<ReadableStream<Uint8Array>> {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return new ReadableStream({ start: (c) => c.close() });
  // The first sentence is asked for before this returns, so a server that's down fails here.
  let current = await speakOne(fetchImpl, settings, sentences[0], signal);
  let index = 0;
  let ahead: Promise<Speech> | null = null;
  const fetchAhead = () => {
    if (ahead || index + 1 >= sentences.length) return;
    ahead = speakOne(fetchImpl, settings, sentences[index + 1], signal);
    ahead.catch(() => undefined); // read (and reported) when its turn comes
  };
  const dropAhead = () => {
    void ahead?.then(
      (s) => {
        s.done();
        void s.reader.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    ahead = null;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await current.reader.read();
          if (!done) {
            fetchAhead();
            controller.enqueue(value);
            return;
          }
          current.done();
          index += 1;
          if (index >= sentences.length) {
            controller.close();
            return;
          }
          // Asked for while the last one came, unless that one had no audio at all.
          const next: Promise<Speech> = ahead ?? speakOne(fetchImpl, settings, sentences[index], signal);
          ahead = null;
          current = await next;
        }
      } catch (err) {
        current.done();
        dropAhead();
        throw current.explain(err);
      }
    },
    cancel(reason) {
      current.done();
      void current.reader.cancel(reason).catch(() => undefined);
      dropAhead();
    },
  });
}

function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .trim();
}

/** One utterance (16 kHz PCM) to text; "" for nothing worth hearing. */
export async function transcribeLocal(
  settings: LocalVoice,
  pcm: Int16Array,
  signal?: AbortSignal,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wavBytes(pcm)], { type: "audio/wav" }), "speech.wav");
  form.append("model", settings.sttModel);
  form.append("language", LANGUAGE);
  form.append("response_format", "json");
  form.append("temperature", "0");
  const { res, done } = await request(fetchImpl, settings, "/audio/transcriptions", { method: "POST", body: form }, signal);
  try {
    // A wrong address, or a server that turns the page away, won't come right; other failures
    // (a clip it couldn't take, a busy moment) count toward MAX_FAILURES.
    if (!res.ok) throw await refused(res, "transcribe", [401, 403, 404, 405].includes(res.status));
    const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
    if (!body || typeof body !== "object") throw new VoiceError("Your speech server's transcription wasn't JSON.", false);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (pcm.length / SCRIBE_RATE < SILENCE_CLIP_SECONDS && SILENCE_PHRASES.has(plain(text))) return "";
    return text;
  } finally {
    done();
  }
}

interface Job {
  pcm: Int16Array;
  callbacks: TranscriberCallbacks;
  cancelled: () => boolean;
}

/**
 * Everyone's utterances on their way to the speech server, one at a time (it's this
 * computer's CPU or GPU): at most MAX_WAITING wait, and past that the oldest is dropped.
 */
export class LocalHearing {
  private waiting: Job[] = [];
  private busy = false;
  private dead = false;
  private failures = 0;
  private abort: AbortController | null = null;

  constructor(private readonly transcribe: (pcm: Int16Array, signal: AbortSignal) => Promise<string>) {}

  /** A transcriber for one person, for the hub. */
  person(callbacks: TranscriberCallbacks): Transcriber {
    return new LocalUtterances(this, callbacks);
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  enqueue(job: Job): void {
    if (this.dead) return;
    this.waiting.push(job);
    if (this.waiting.length > MAX_WAITING) this.waiting.shift();
    if (!this.busy) void this.run();
  }

  close(): void {
    this.dead = true;
    this.waiting = [];
    this.abort?.abort();
  }

  private async run(): Promise<void> {
    this.busy = true;
    while (!this.dead && this.waiting.length) {
      const job = this.waiting.shift()!;
      if (job.cancelled()) continue;
      this.abort = new AbortController();
      try {
        const text = await this.transcribe(job.pcm, this.abort.signal);
        this.failures = 0;
        if (text && !this.dead && !job.cancelled()) job.callbacks.onText(text);
      } catch (err) {
        if (this.dead) break;
        const error = err instanceof VoiceError ? err : new VoiceError("Your speech server couldn't transcribe.", false);
        this.failures += 1;
        if (error.fatal || this.failures >= MAX_FAILURES) {
          this.close();
          job.callbacks.onFatal(error.message);
        }
      }
    }
    this.abort = null;
    this.busy = false;
  }
}

/** One person's speech, held until they pause, then sent as one utterance. */
class LocalUtterances implements Transcriber {
  private frames: Int16Array[] = [];
  private samples = 0;
  private closed = false;

  constructor(
    private readonly hearing: LocalHearing,
    private readonly callbacks: TranscriberCallbacks,
  ) {}

  send(pcm: Int16Array, commit: boolean, keep = true): void {
    if (this.closed) return;
    this.frames.push(pcm);
    this.samples += pcm.length;
    if (!commit) return;
    const frames = this.frames;
    const clip = new Int16Array(this.samples);
    this.frames = [];
    this.samples = 0;
    if (!keep) return; // a cough or a click
    let at = 0;
    for (const frame of frames) {
      clip.set(frame, at);
      at += frame.length;
    }
    this.hearing.enqueue({ pcm: clip, callbacks: this.callbacks, cancelled: () => this.closed });
  }

  close(): void {
    this.closed = true;
    this.frames = [];
    this.samples = 0;
  }
}

/**
 * The agent's local voice: speaks through the server, and says the fixed phrases ("Yes?")
 * from memory once made, since a server on a CPU is slow to start each line.
 */
export class LocalVoiceOut {
  private readonly cache = new Map<string, Uint8Array>();
  private readonly closing = new AbortController();

  constructor(
    private readonly settings: LocalVoice,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async warm(phrases: readonly string[]): Promise<void> {
    for (const phrase of phrases) {
      if (this.closing.signal.aborted) return;
      try {
        const stream = await synthesizeLocal(this.settings, phrase, this.closing.signal, this.fetchImpl);
        this.cache.set(phrase.trim(), new Uint8Array(await new Response(stream).arrayBuffer()));
      } catch {
        // Made when first said instead.
      }
    }
  }

  synthesize(text: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const cached = this.cache.get(text.trim());
    if (cached) {
      return Promise.resolve(
        new ReadableStream({
          start(c) {
            c.enqueue(cached.slice());
            c.close();
          },
        }),
      );
    }
    return synthesizeLocal(this.settings, text, signal, this.fetchImpl);
  }

  close(): void {
    this.closing.abort();
  }
}
