import { TTS_RATE, VoiceError } from "./settings";
import { PcmReader } from "./pcm";

/** What the agent can do with its voice. */
export interface AgentVoice {
  /**
   * Say a line; resolves once it has been said, cut short or skipped. It stops at `until`
   * (ms since the epoch: the end of the agent's turn).
   */
  speak(text: string, options?: { until?: number }): Promise<void>;
}

/** Answers waiting to be spoken; past this, new ones are dropped (they're in the chat anyway). */
export const MAX_WAITING = 3;
/** Head start before the first sound, so a slow network chunk doesn't leave a gap. */
export const LEAD_SECONDS = 0.15;
/** People first: wait this long for them to stop talking before speaking (the chat is there). */
export const PEOPLE_FIRST_MS = 5000;
/** Stop speaking when a person talks over the agent for longer than this. */
export const BARGE_IN_MS = 1000;
/**
 * Played audio is still being encoded, sent and buffered on its way to people: a line counts as
 * said this much later, so the next voice (another agent's turn) never starts over its last words.
 */
export const PLAYOUT_TAIL_MS = 250;
/**
 * No audio for this long once what came has played (or no answer at all from the voice) means it
 * has stalled, as on a dropped connection: give up on the line.
 */
export const STALL_MS = 10_000;
/** setTimeout's longest wait. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const POLL_MS = 100;
const STALLED = Symbol("stalled");

/** The parts of WebAudio this uses (the real AudioContext in the browser, a fake in tests). */
export interface AudioOut {
  readonly currentTime: number;
  createBuffer(channels: number, length: number, sampleRate: number): { copyToChannel(data: Float32Array, channel: number): void };
  createBufferSource(): {
    buffer: unknown;
    connect(node: unknown): unknown;
    start(when: number): void;
    stop(): void;
  };
}

export interface SpeakerOptions {
  out: AudioOut;
  /** Where the agent's microphone track comes from (a MediaStreamAudioDestinationNode). */
  destination: unknown;
  synthesize: (text: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
  onError: (error: VoiceError) => void;
  /** Whether a person in the meeting is talking right now. */
  peopleTalking?: () => boolean;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  /** No audio for this long after what came has played gives up on the line (STALL_MS). */
  stallMs?: number;
}

interface Line {
  text: string;
  until?: number;
  done: () => void;
}

/**
 * Speaks answers one at a time into the agent's microphone track: ElevenLabs streams PCM,
 * and each chunk is scheduled right after the one before it. People first: a line waits a
 * little for people to stop talking, and stops if a person talks over it.
 */
export class AgentSpeaker implements AgentVoice {
  private readonly waiting: Line[] = [];
  private running = false;
  private closed = false;
  private abort: AbortController | null = null;
  private playing: ReturnType<AudioOut["createBufferSource"]>[] = [];
  private cut = false;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly peopleTalking: () => boolean;
  private readonly stallMs: number;

  constructor(private readonly options: SpeakerOptions) {
    this.stallMs = options.stallMs ?? STALL_MS;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.peopleTalking = options.peopleTalking ?? (() => false);
  }

  speak(text: string, options: { until?: number } = {}): Promise<void> {
    const line = text.trim();
    if (this.closed || !line || this.waiting.length >= MAX_WAITING) return Promise.resolve();
    return new Promise((done) => {
      this.waiting.push({ text: line, until: options.until, done });
      if (!this.running) void this.run();
    });
  }

  /** Stop the line being said now (the next one still goes). */
  stop(): void {
    this.cut = true;
    this.abort?.abort();
    this.silence();
  }

  close(): void {
    this.closed = true;
    for (const line of this.waiting.splice(0)) line.done();
    this.stop();
  }

  private silence(): void {
    for (const source of this.playing) {
      try {
        source.stop();
      } catch {
        // already finished
      }
    }
    this.playing = [];
  }

  private async run(): Promise<void> {
    this.running = true;
    while (!this.closed && this.waiting.length) {
      const line = this.waiting.shift()!;
      this.cut = false;
      try {
        if (await this.peopleDone(line.until)) await this.say(line);
      } catch (err) {
        if (!this.closed && !this.cut) {
          const error = err instanceof VoiceError ? err : new VoiceError("Your agent's voice stopped partway.", false);
          this.options.onError(error);
          if (error.fatal) this.close();
        }
      } finally {
        line.done();
      }
    }
    this.running = false;
  }

  /** Wait (a little) for people to stop talking. False: they kept on, so skip the voice. */
  private async peopleDone(until: number | undefined): Promise<boolean> {
    const giveUp = Math.min(this.now() + PEOPLE_FIRST_MS, until ?? Infinity);
    while (this.peopleTalking()) {
      if (this.closed || this.now() >= giveUp) return false;
      await this.wait(POLL_MS);
    }
    return true;
  }

  /**
   * `step`, or STALLED if the line has to give up first: at the turn's end, or when nothing more
   * has come for stallMs after the audio already scheduled (`audioLeftMs` of it) has played. A
   * voice that never answers or stops mid-stream must not keep the turn, or the answers after it.
   */
  private within<T>(step: Promise<T>, until: number | undefined, audioLeftMs: number): Promise<T | typeof STALLED> {
    const limit = Math.max(0, Math.min((until ?? Infinity) - this.now(), audioLeftMs + this.stallMs, MAX_TIMER_MS));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<typeof STALLED>((resolve) => (timer = setTimeout(() => resolve(STALLED), limit)));
    step.catch(() => undefined); // if it fails after we've given up on it
    return Promise.race([step, stalled]).finally(() => clearTimeout(timer));
  }

  private async say(line: Line): Promise<void> {
    const { out, destination } = this.options;
    this.abort = new AbortController();
    const interrupted = this.interruptions(line.until);
    const asked = this.options.synthesize(line.text, this.abort.signal);
    const stream = await this.within(asked, line.until, 0);
    if (stream === STALLED) {
      this.stop();
      void asked.then((late) => late.cancel().catch(() => undefined), () => undefined);
      return;
    }
    const reader = stream.getReader();
    const pcm = new PcmReader();
    let at = 0;
    try {
      for (;;) {
        const next = await this.within(reader.read(), line.until, Math.max(0, at - out.currentTime) * 1000);
        if (next === STALLED) {
          this.stop();
          break;
        }
        const { done, value } = next;
        if (done || this.closed || this.cut || interrupted()) break;
        const samples = pcm.read(value);
        if (samples.length === 0) continue;
        const buffer = out.createBuffer(1, samples.length, TTS_RATE);
        buffer.copyToChannel(samples, 0);
        const source = out.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        // A head start only when nothing is queued: chunks after the first follow on directly.
        if (at < out.currentTime) at = out.currentTime + LEAD_SECONDS;
        source.start(at);
        this.playing.push(source);
        at += samples.length / TTS_RATE;
      }
    } catch (err) {
      // The voice failed partway: what's scheduled would play on after the turn is given back,
      // under whoever speaks next.
      this.silence();
      throw err;
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    // Let this line finish before the next one (or the next agent) starts, unless cut short.
    const end = this.now() + (at > 0 ? Math.max(0, at - out.currentTime) * 1000 + PLAYOUT_TAIL_MS : 0);
    while (!this.closed && !this.cut && this.now() < end) {
      if (interrupted()) {
        this.stop();
        break;
      }
      await this.wait(Math.min(POLL_MS, end - this.now()));
    }
    this.playing = [];
  }

  /** Whether to stop now: the turn ran out, or a person has been talking over the agent. */
  private interruptions(until: number | undefined): () => boolean {
    let since: number | null = null;
    return () => {
      const now = this.now();
      if (until !== undefined && now >= until) return true;
      if (!this.peopleTalking()) {
        since = null;
        return false;
      }
      since ??= now;
      return now - since > BARGE_IN_MS;
    };
  }
}
