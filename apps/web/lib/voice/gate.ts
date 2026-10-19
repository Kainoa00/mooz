import { SCRIBE_RATE, rms } from "./pcm";

/** Louder than this (RMS, full scale = 1) counts as someone talking: about -42 dBFS. */
export const SPEECH_LEVEL = 0.008;
/** Audio kept from just before speech starts, so the first word ("Hey…") isn't clipped. */
export const PRE_ROLL_MS = 600;
/** Quiet kept sending after speech, longer than Scribe's pause detection so it commits on its own. */
export const HANGOVER_MS = 1500;

export interface GateOutput {
  /** Frames to transcribe now, oldest first. */
  frames: Int16Array[];
  /** True on the last frame of a stretch of speech: commit what was said. */
  commit: boolean;
}

/**
 * Sends a track's audio only while someone is talking on it (plus a little either side), so
 * the owner pays to transcribe speech, not silence. Time is counted in samples, not clock time.
 */
export class SpeechGate {
  private readonly preRoll = (PRE_ROLL_MS / 1000) * SCRIBE_RATE;
  private readonly hangover = (HANGOVER_MS / 1000) * SCRIBE_RATE;
  private buffered: Int16Array[] = [];
  private bufferedSamples = 0;
  private open = false;
  private quietFor = 0;

  constructor(private readonly level = SPEECH_LEVEL) {}

  push(frame: Int16Array): GateOutput {
    const loud = rms(frame) >= this.level;
    if (this.open) {
      this.quietFor = loud ? 0 : this.quietFor + frame.length;
      if (this.quietFor >= this.hangover) {
        this.open = false;
        return { frames: [frame], commit: true };
      }
      return { frames: [frame], commit: false };
    }
    if (loud) {
      const frames = [...this.buffered, frame];
      this.buffered = [];
      this.bufferedSamples = 0;
      this.open = true;
      this.quietFor = 0;
      return { frames, commit: false };
    }
    this.buffered.push(frame);
    this.bufferedSamples += frame.length;
    while (this.buffered.length > 1 && this.bufferedSamples - this.buffered[0].length >= this.preRoll) {
      this.bufferedSamples -= this.buffered.shift()!.length;
    }
    return { frames: [], commit: false };
  }
}
