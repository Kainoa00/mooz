import { TTS_RATE, VoiceError } from "./elevenlabs";
import { PcmReader } from "./pcm";

/** What the agent can do with its voice. */
export interface AgentVoice {
  speak(text: string): void;
}

/** Answers waiting to be spoken; past this, new ones are dropped (they're in the chat anyway). */
export const MAX_WAITING = 3;
/** Head start before the first sound, so a slow network chunk doesn't leave a gap. */
export const LEAD_SECONDS = 0.15;

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
  wait?: (ms: number) => Promise<void>;
}

/**
 * Speaks answers one at a time into the agent's microphone track: ElevenLabs streams PCM,
 * and each chunk is scheduled right after the one before it.
 */
export class AgentSpeaker implements AgentVoice {
  private readonly waiting: string[] = [];
  private running = false;
  private closed = false;
  private abort: AbortController | null = null;
  private playing: ReturnType<AudioOut["createBufferSource"]>[] = [];
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly options: SpeakerOptions) {
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  speak(text: string): void {
    const line = text.trim();
    if (this.closed || !line || this.waiting.length >= MAX_WAITING) return;
    this.waiting.push(line);
    if (!this.running) void this.run();
  }

  close(): void {
    this.closed = true;
    this.waiting.length = 0;
    this.abort?.abort();
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
      const text = this.waiting.shift()!;
      try {
        await this.say(text);
      } catch (err) {
        if (this.closed) break;
        const error = err instanceof VoiceError ? err : new VoiceError("Your agent's voice stopped partway.", false);
        this.options.onError(error);
        if (error.fatal) this.close();
      }
    }
    this.running = false;
  }

  private async say(text: string): Promise<void> {
    const { out, destination } = this.options;
    this.abort = new AbortController();
    const stream = await this.options.synthesize(text, this.abort.signal);
    const reader = stream.getReader();
    const pcm = new PcmReader();
    let at = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.closed) break;
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
    } finally {
      reader.releaseLock();
    }
    // Let this answer finish before the next one starts.
    const left = at - out.currentTime;
    if (left > 0 && !this.closed) await this.wait(left * 1000);
    this.playing = [];
  }
}
