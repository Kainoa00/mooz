import { describe, expect, it } from "vitest";
import { Downsampler, PcmReader, SCRIBE_RATE, base64, pcmBase64, rms, toInt16, wavBytes } from "./pcm";

describe("toInt16", () => {
  it("scales and clips", () => {
    expect([...toInt16([0, 1, -1, 0.5, 2, -3])]).toEqual([0, 32767, -32768, 16384, 32767, -32768]);
  });
});

describe("rms", () => {
  it("is 0 for silence and 0.5 for a half-scale square wave", () => {
    expect(rms(new Int16Array(0))).toBe(0);
    expect(rms(new Int16Array(100))).toBe(0);
    expect(rms(new Int16Array([16384, -16384]))).toBeCloseTo(0.5, 5);
  });
});

describe("wavBytes", () => {
  it("wraps PCM in a 16-bit mono WAV header", () => {
    const wav = wavBytes(new Int16Array([1, -2, 300]).subarray(1));
    const view = new DataView(wav.buffer);
    const text = (at: number, n: number) => String.fromCharCode(...wav.subarray(at, at + n));
    expect(wav.length).toBe(48);
    expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(40);
    expect([view.getUint16(20, true), view.getUint16(22, true), view.getUint16(34, true)]).toEqual([1, 1, 16]);
    expect([view.getUint32(24, true), view.getUint32(28, true)]).toEqual([SCRIBE_RATE, SCRIBE_RATE * 2]);
    expect(view.getUint32(40, true)).toBe(4);
    expect([view.getInt16(44, true), view.getInt16(46, true)]).toEqual([-2, 300]);
  });
});

describe("base64", () => {
  it("encodes bytes, including long buffers", () => {
    expect(base64(new Uint8Array([104, 105]))).toBe("aGk=");
    const long = new Uint8Array(100_000).fill(65);
    expect(atob(base64(long))).toBe("A".repeat(100_000));
  });

  it("encodes PCM as little-endian bytes, honoring the view's offset", () => {
    const pcm = new Int16Array([0, 1, -1]).subarray(1);
    expect([...Uint8Array.from(atob(pcmBase64(pcm)), (c) => c.charCodeAt(0))]).toEqual([1, 0, 255, 255]);
  });
});

describe("Downsampler", () => {
  it("averages 48 kHz down to 16 kHz across block boundaries", () => {
    const d = new Downsampler(48_000);
    const a = d.process(new Float32Array([0.3, 0.3, 0.3, 0.6]));
    const b = d.process(new Float32Array([0.6, 0.6, 0.9]));
    expect([...a].map((s) => s / 32767)).toEqual([expect.closeTo(0.3, 3)]);
    expect([...b].map((s) => s / 32767)).toEqual([expect.closeTo(0.6, 3)]);
    expect([...d.process(new Float32Array([0.9, 0.9]))].map((s) => s / 32767)).toEqual([expect.closeTo(0.9, 3)]);
  });

  it("keeps the rate exact at 44.1 kHz", () => {
    const d = new Downsampler(44_100);
    let total = 0;
    for (let i = 0; i < 100; i++) total += d.process(new Float32Array(441)).length;
    expect(Math.abs(total - 16_000)).toBeLessThanOrEqual(1);
  });

  it("passes 16 kHz through and refuses to upsample", () => {
    expect(new Downsampler(16_000).process(new Float32Array([0.5, -0.5])).length).toBe(2);
    expect(() => new Downsampler(8000)).toThrow(/8000/);
  });
});

describe("PcmReader", () => {
  it("reads little-endian samples even when a chunk splits one", () => {
    const r = new PcmReader();
    expect([...r.read(new Uint8Array([0x00, 0x40, 0x00]))]).toEqual([0.5]);
    expect([...r.read(new Uint8Array([0xc0]))]).toEqual([-0.5]);
    expect([...r.read(new Uint8Array([]))]).toEqual([]);
  });
});
