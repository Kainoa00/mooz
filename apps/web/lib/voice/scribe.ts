import { VoiceError } from "./elevenlabs";
import { SpeechGate } from "./gate";
import { Downsampler, SCRIBE_RATE, pcmBase64 } from "./pcm";

/** The most people one tab transcribes at once (each is its own stream, on the owner's bill). */
export const MAX_STREAMS = 6;
/** Close a stream after this long without speech; the next word opens a fresh one. */
export const IDLE_CLOSE_MS = 15_000;
/** Audio held while a stream connects (or waits to retry), in samples: 10 s. */
export const MAX_QUEUED_SAMPLES = 10 * SCRIBE_RATE;
/** Waits between failed attempts; the last one repeats. */
export const RETRY_DELAYS_MS = [1000, 2000, 5000, 15_000, 30_000];
/** Give up after this many failures in a row (about ten minutes of trying). */
export const MAX_FAILURES = 25;

const FATAL_ERRORS = new Set(["auth_error", "quota_exceeded", "unaccepted_terms"]);
const FATAL_MESSAGES: Record<string, string> = {
  auth_error: "ElevenLabs didn't accept your API key.",
  quota_exceeded: "Your ElevenLabs account is out of credits.",
  unaccepted_terms: "Accept ElevenLabs' speech-to-text terms in your ElevenLabs account first.",
};

/** The parts of a WebSocket this uses (a real one in the browser, a fake in tests). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ScribeOptions {
  /** A fresh single-use token for each connection. */
  token: () => Promise<string>;
  /** Builds the URL for a token. */
  url: (token: string) => string;
  connect?: (url: string) => SocketLike;
  onText: (text: string) => void;
  /** Called once when transcription can't go on (bad key, no credits); the stream is done. */
  onFatal: (message: string) => void;
}

type State = "idle" | "connecting" | "open" | "dead";

/**
 * One person's Scribe realtime stream: opened when they start talking, fed while they talk,
 * closed after a quiet spell, and reopened (with a new token) when they talk again.
 */
export class ScribeStream {
  private state: State = "idle";
  private socket: SocketLike | null = null;
  private queue: { pcm: Int16Array; commit: boolean }[] = [];
  private queued = 0;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly connect: (url: string) => SocketLike;

  constructor(private readonly options: ScribeOptions) {
    this.connect = options.connect ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  }

  get status(): State {
    return this.state;
  }

  send(pcm: Int16Array, commit: boolean): void {
    if (this.state === "dead" || pcm.length === 0) return;
    this.clearIdle();
    if (this.state === "open" && this.socket) {
      this.write(this.socket, pcm, commit);
    } else {
      this.queue.push({ pcm, commit });
      this.queued += pcm.length;
      while (this.queued > MAX_QUEUED_SAMPLES && this.queue.length > 1) this.queued -= this.queue.shift()!.pcm.length;
      if (this.state === "idle" && !this.retryTimer) void this.open();
    }
    if (commit) this.idleTimer = setTimeout(() => this.idle(), IDLE_CLOSE_MS);
  }

  close(): void {
    this.state = "dead";
    this.clearIdle();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.queue = [];
    this.drop();
  }

  private write(socket: SocketLike, pcm: Int16Array, commit: boolean): void {
    socket.send(
      JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: pcmBase64(pcm), commit, sample_rate: SCRIBE_RATE }),
    );
  }

  private async open(): Promise<void> {
    this.state = "connecting";
    let token: string;
    try {
      token = await this.options.token();
    } catch (err) {
      if (err instanceof VoiceError && err.fatal) this.fail(err.message);
      else this.retry();
      return;
    }
    if (this.state !== "connecting") return; // closed meanwhile
    let socket: SocketLike;
    try {
      socket = this.connect(this.options.url(token));
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    let started = false;
    socket.onmessage = (ev) => {
      if (this.socket !== socket || typeof ev.data !== "string") return;
      let msg: { message_type?: unknown; text?: unknown; error?: unknown };
      try {
        msg = JSON.parse(ev.data) as typeof msg;
      } catch {
        return;
      }
      const type = typeof msg.message_type === "string" ? msg.message_type : "";
      if (type === "session_started") {
        started = true;
        this.failures = 0;
        this.state = "open";
        for (const { pcm, commit } of this.queue) this.write(socket, pcm, commit);
        this.queue = [];
        this.queued = 0;
      } else if (type === "committed_transcript") {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        if (text) this.options.onText(text);
      } else if (FATAL_ERRORS.has(type)) {
        this.fail(FATAL_MESSAGES[type]);
      }
      // Other errors (time limits, too little audio, throttling) end in a close, handled below.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.state === "dead") return;
      if (started) {
        // A stream that worked and was closed (time limit, silence): reopen on the next word,
        // or right away if words are already waiting.
        this.state = "idle";
        if (this.queue.length) void this.open();
      } else {
        this.retry();
      }
    };
    socket.onerror = () => undefined; // a close always follows
  }

  private retry(): void {
    this.state = "idle";
    this.drop();
    this.failures += 1;
    if (this.failures > MAX_FAILURES) {
      this.fail("Couldn't keep listening through ElevenLabs.");
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(this.failures - 1, RETRY_DELAYS_MS.length - 1)];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.state === "idle" && this.queue.length) void this.open();
    }, delay);
  }

  private fail(message: string): void {
    if (this.state === "dead") return;
    this.close();
    this.options.onFatal(message);
  }

  private idle(): void {
    this.idleTimer = null;
    if (this.state !== "open") return;
    this.state = "idle";
    this.drop();
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= 1) socket.close();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

export interface HubTrack {
  /** Unique per audio track (changes when a device switch swaps the track). */
  key: string;
  identity: string;
}

interface Pipeline {
  identity: string;
  downsampler: Downsampler;
  gate: SpeechGate;
  stream: ScribeStream;
}

/**
 * Everyone this tab transcribes for its connector agent: up to MAX_STREAMS tracks, each
 * through a speech gate into its own Scribe stream. Who said what comes from the track.
 */
export class ScribeHub {
  private readonly pipelines = new Map<string, Pipeline>();
  private dead = false;

  constructor(
    private readonly sampleRate: number,
    private readonly makeStream: (callbacks: Pick<ScribeOptions, "onText" | "onFatal">) => ScribeStream,
    private readonly onHeard: (identity: string, text: string) => void,
    private readonly onFatal: (message: string) => void,
  ) {}

  /** Follows the tracks in the meeting; returns the keys being transcribed. */
  sync(tracks: readonly HubTrack[]): string[] {
    const wanted = new Map(tracks.map((t) => [t.key, t]));
    for (const [key, p] of this.pipelines) {
      if (!wanted.has(key)) {
        p.stream.close();
        this.pipelines.delete(key);
      }
    }
    for (const track of tracks) {
      if (this.dead || this.pipelines.size >= MAX_STREAMS) break;
      if (this.pipelines.has(track.key)) continue;
      const stream = this.makeStream({
        onText: (text) => this.onHeard(track.identity, text),
        onFatal: (message) => this.fatal(message),
      });
      this.pipelines.set(track.key, {
        identity: track.identity,
        downsampler: new Downsampler(this.sampleRate),
        gate: new SpeechGate(),
        stream,
      });
    }
    return [...this.pipelines.keys()];
  }

  feed(key: string, block: Float32Array): void {
    const p = this.pipelines.get(key);
    if (!p) return;
    const { frames, commit } = p.gate.push(p.downsampler.process(block));
    frames.forEach((frame, i) => p.stream.send(frame, commit && i === frames.length - 1));
  }

  close(): void {
    for (const p of this.pipelines.values()) p.stream.close();
    this.pipelines.clear();
  }

  private fatal(message: string): void {
    if (this.dead) return;
    this.dead = true;
    this.close();
    this.onFatal(message);
  }
}
