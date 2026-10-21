import { SCRIBE_GATE, SpeechGate, type GateOptions } from "./gate";
import { Downsampler } from "./pcm";

/** The most people one tab transcribes at once (each through the owner's own speech service). */
export const MAX_STREAMS = 6;

/** Turns one person's gated speech into text: an ElevenLabs Scribe stream, or a local speech server. */
export interface Transcriber {
  /** `commit` ends an utterance; with it, `keep` says whether it held enough speech to transcribe. */
  send(pcm: Int16Array, commit: boolean, keep?: boolean): void;
  close(): void;
}

export interface TranscriberCallbacks {
  onText: (text: string) => void;
  /** Called when transcription can't go on (a bad key, no server); everyone's hearing stops. */
  onFatal: (message: string) => void;
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
  transcriber: Transcriber;
}

/**
 * Everyone this tab transcribes for its connector agent: up to MAX_STREAMS tracks, each
 * through a speech gate into its own transcriber. Who said what comes from the track.
 */
export class HearingHub {
  private readonly pipelines = new Map<string, Pipeline>();
  private dead = false;

  constructor(
    private readonly sampleRate: number,
    private readonly makeTranscriber: (callbacks: TranscriberCallbacks) => Transcriber,
    private readonly onHeard: (identity: string, text: string) => void,
    private readonly onFatal: (message: string) => void,
    private readonly gate: GateOptions = SCRIBE_GATE,
  ) {}

  /** Follows the tracks in the meeting; returns the keys being transcribed. */
  sync(tracks: readonly HubTrack[]): string[] {
    const wanted = new Map(tracks.map((t) => [t.key, t]));
    for (const [key, p] of this.pipelines) {
      if (!wanted.has(key)) {
        p.transcriber.close();
        this.pipelines.delete(key);
      }
    }
    for (const track of tracks) {
      if (this.dead || this.pipelines.size >= MAX_STREAMS) break;
      if (this.pipelines.has(track.key)) continue;
      const transcriber = this.makeTranscriber({
        onText: (text) => this.onHeard(track.identity, text),
        onFatal: (message) => this.fatal(message),
      });
      this.pipelines.set(track.key, {
        identity: track.identity,
        downsampler: new Downsampler(this.sampleRate),
        gate: new SpeechGate(this.gate),
        transcriber,
      });
    }
    return [...this.pipelines.keys()];
  }

  feed(key: string, block: Float32Array): void {
    const p = this.pipelines.get(key);
    if (!p) return;
    const { frames, commit, keep } = p.gate.push(p.downsampler.process(block));
    frames.forEach((frame, i) => {
      if (commit && i === frames.length - 1) p.transcriber.send(frame, true, keep);
      else p.transcriber.send(frame, false);
    });
  }

  close(): void {
    for (const p of this.pipelines.values()) p.transcriber.close();
    this.pipelines.clear();
  }

  private fatal(message: string): void {
    if (this.dead) return;
    this.dead = true;
    this.close();
    this.onFatal(message);
  }
}
