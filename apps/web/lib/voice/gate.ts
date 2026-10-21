import { SCRIBE_RATE, rms } from "./pcm";

/** Louder than this (RMS, full scale = 1) counts as someone talking: about -42 dBFS. */
export const SPEECH_LEVEL = 0.008;
/** Audio kept from just before speech starts, so the first word ("Hey…") isn't clipped. */
export const PRE_ROLL_MS = 600;
/** Quiet kept sending after speech, longer than Scribe's pause detection so it commits on its own. */
export const HANGOVER_MS = 1500;

export interface GateOptions {
  level: number;
  preRollMs: number;
  /** Quiet that ends an utterance. */
  hangoverMs: number;
  /** An utterance this long is cut and goes on as a new one (0: never). */
  maxUtteranceMs: number;
  /** An utterance with less speech than this isn't worth transcribing (a cough, a click). */
  minSpeechMs: number;
}

/** For streaming transcription (ElevenLabs Scribe), which finds pauses itself. */
export const SCRIBE_GATE: GateOptions = {
  level: SPEECH_LEVEL,
  preRollMs: PRE_ROLL_MS,
  hangoverMs: HANGOVER_MS,
  maxUtteranceMs: 0,
  minSpeechMs: 0,
};

/** For a local speech server, which transcribes one utterance per request. */
export const LOCAL_GATE: GateOptions = { ...SCRIBE_GATE, hangoverMs: 700, maxUtteranceMs: 15_000, minSpeechMs: 300 };

export interface GateOutput {
  /** Frames to transcribe now, oldest first. */
  frames: Int16Array[];
  /** True on the last frame of a stretch of speech: commit what was said. */
  commit: boolean;
  /** With a commit: whether it had enough speech to be worth transcribing. */
  keep?: boolean;
}

const samples = (ms: number) => (ms / 1000) * SCRIBE_RATE;

/**
 * Sends a track's audio only while someone is talking on it (plus a little either side), so
 * the owner pays to transcribe speech, not silence. Time is counted in samples, not clock time.
 * The bridge has the same gate (bridge/src/mooz_agent/gate.py); both run gate_cases.json.
 */
export class SpeechGate {
  private readonly options: GateOptions;
  private buffered: Int16Array[] = [];
  private bufferedSamples = 0;
  private open = false;
  private quietFor = 0;
  private utterance = 0;
  private speech = 0;

  constructor(options: Partial<GateOptions> = {}) {
    this.options = { ...SCRIBE_GATE, ...options };
  }

  push(frame: Int16Array): GateOutput {
    const { level, preRollMs, hangoverMs, maxUtteranceMs } = this.options;
    const loud = rms(frame) >= level;
    if (this.open) {
      this.utterance += frame.length;
      if (loud) this.speech += frame.length;
      this.quietFor = loud ? 0 : this.quietFor + frame.length;
      if (this.quietFor >= samples(hangoverMs)) {
        this.open = false;
        return this.cut(frame);
      }
      // Too long to send as one: cut here, and the speech goes on as a new utterance.
      if (maxUtteranceMs > 0 && this.utterance >= samples(maxUtteranceMs)) return this.cut(frame);
      return { frames: [frame], commit: false };
    }
    if (loud) {
      const frames = [...this.buffered, frame];
      this.utterance = this.bufferedSamples + frame.length;
      this.speech = frame.length;
      this.buffered = [];
      this.bufferedSamples = 0;
      this.open = true;
      this.quietFor = 0;
      return { frames, commit: false };
    }
    this.buffered.push(frame);
    this.bufferedSamples += frame.length;
    while (this.buffered.length > 1 && this.bufferedSamples - this.buffered[0].length >= samples(preRollMs)) {
      this.bufferedSamples -= this.buffered.shift()!.length;
    }
    return { frames: [], commit: false };
  }

  private cut(frame: Int16Array): GateOutput {
    const keep = this.speech >= samples(this.options.minSpeechMs);
    this.utterance = 0;
    this.speech = 0;
    this.quietFor = 0;
    return { frames: [frame], commit: true, keep };
  }
}
