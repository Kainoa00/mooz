/** Audio sample plumbing for browser voice: 16-bit PCM in and out, at the rates the speech services take. */

export const SCRIBE_RATE = 16_000;

/** Float samples in [-1, 1] to little-endian 16-bit PCM, clipping anything louder. */
export function toInt16(samples: ArrayLike<number>): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Loudness of a frame, 0 (silence) to 1 (full scale). */
export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (const s of pcm) sum += (s / 0x8000) ** 2;
  return Math.sqrt(sum / pcm.length);
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function pcmBase64(pcm: Int16Array): string {
  return base64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

/** Mono 16-bit PCM as a WAV file (what a local speech server transcribes). */
export function wavBytes(pcm: Int16Array, rate = SCRIBE_RATE): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // the format chunk's size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes a second
  view.setUint16(32, 2, true); // bytes a sample
  view.setUint16(34, 16, true); // bits a sample
  text(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  pcm.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return out;
}

/**
 * Down to 16 kHz for transcription, averaging each output sample's span of input (a box
 * filter: crude, but plenty for speech). Keeps its place across blocks.
 */
export class Downsampler {
  private readonly ratio: number;
  private rest = new Float32Array(0);
  private pos = 0;

  constructor(fromRate: number, toRate = SCRIBE_RATE) {
    if (!(fromRate >= toRate)) throw new Error(`can't downsample ${fromRate} Hz to ${toRate} Hz`);
    this.ratio = fromRate / toRate;
  }

  process(block: Float32Array): Int16Array {
    const buf = new Float32Array(this.rest.length + block.length);
    buf.set(this.rest);
    buf.set(block, this.rest.length);
    const out: number[] = [];
    let pos = this.pos;
    while (pos + this.ratio <= buf.length) {
      const from = Math.floor(pos);
      const to = Math.max(from + 1, Math.floor(pos + this.ratio));
      let sum = 0;
      for (let i = from; i < to; i++) sum += buf[i];
      out.push(sum / (to - from));
      pos += this.ratio;
    }
    const keep = Math.floor(pos);
    this.rest = buf.slice(keep);
    this.pos = pos - keep;
    return toInt16(out);
  }
}

/** Streamed 16-bit PCM bytes to float samples; a chunk can end halfway through a sample. */
export class PcmReader {
  private carry: number | null = null;

  read(chunk: Uint8Array): Float32Array {
    let bytes = chunk;
    if (this.carry !== null) {
      bytes = new Uint8Array(chunk.length + 1);
      bytes[0] = this.carry;
      bytes.set(chunk, 1);
      this.carry = null;
    }
    const whole = bytes.length - (bytes.length % 2);
    if (whole < bytes.length) this.carry = bytes[bytes.length - 1];
    const view = new DataView(bytes.buffer, bytes.byteOffset, whole);
    const out = new Float32Array(whole / 2);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
    return out;
  }
}
