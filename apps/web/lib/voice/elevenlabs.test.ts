import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_ID, VoiceError, scribeUrl, singleUseToken, synthesize } from "./elevenlabs";
import { parseVoiceSettings, readVoiceSettings, saveVoiceSettings } from "./settings";

const KEY = "sk_0123456789abcdef0123456789abcdef";

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const reply = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("voice settings", () => {
  it("checks the key and voice, defaulting the voice", () => {
    expect(parseVoiceSettings(`  ${KEY} `, "")).toEqual({ provider: "elevenlabs", apiKey: KEY, voiceId: DEFAULT_VOICE_ID });
    expect(parseVoiceSettings(KEY, "abcDEF123456")).toEqual({ provider: "elevenlabs", apiKey: KEY, voiceId: "abcDEF123456" });
    expect(parseVoiceSettings("short", "")).toMatch(/API key/);
    expect(parseVoiceSettings("has spaces in it, so no key", "")).toMatch(/API key/);
    expect(parseVoiceSettings(KEY, "../../v1/user")).toMatch(/voice ID/);
  });

  it("saves in this browser, and ignores anything tampered with", () => {
    const store = memoryStore();
    expect(readVoiceSettings(store)).toBeNull();
    expect(saveVoiceSettings({ provider: "elevenlabs", apiKey: KEY, voiceId: DEFAULT_VOICE_ID }, store)).toBe(true);
    expect(readVoiceSettings(store)).toEqual({ provider: "elevenlabs", apiKey: KEY, voiceId: DEFAULT_VOICE_ID });

    store.data.set("mooz.voice", JSON.stringify({ apiKey: KEY, voiceId: "../evil" }));
    expect(readVoiceSettings(store)).toBeNull();
    store.data.set("mooz.voice", "{not json");
    expect(readVoiceSettings(store)).toBeNull();

    expect(saveVoiceSettings(null, store)).toBe(true);
    expect(store.data.size).toBe(0);
    expect(saveVoiceSettings(null, null)).toBe(false);
    expect(readVoiceSettings(null)).toBeNull();
  });
});

describe("singleUseToken", () => {
  it("asks ElevenLabs, with the key, for a one-time token", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { token: "sutkn_1" }));
    expect(await singleUseToken(KEY, "realtime_scribe", fetchImpl)).toBe("sutkn_1");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
      method: "POST",
      headers: { "xi-api-key": KEY },
    });
  });

  it("tells a bad key or no credits (no point retrying) from a hiccup", async () => {
    const attempt = (res: Response | null) =>
      singleUseToken(KEY, "realtime_scribe", async () => (res ? res : Promise.reject(new TypeError("offline")))).catch(
        (e: VoiceError) => e,
      );
    expect(await attempt(reply(401, {}))).toMatchObject({ fatal: true, message: expect.stringMatching(/key/) });
    expect(await attempt(reply(402, {}))).toMatchObject({ fatal: true, message: expect.stringMatching(/credits/) });
    expect(await attempt(reply(400, "quota_exceeded"))).toMatchObject({ fatal: true });
    expect(await attempt(reply(503, "busy"))).toMatchObject({ fatal: false, message: expect.stringMatching(/503/) });
    expect(await attempt(null)).toMatchObject({ fatal: false, message: expect.stringMatching(/reach/) });
    expect(await attempt(reply(200, { nope: 1 }))).toMatchObject({ fatal: false });
  });
});

describe("scribeUrl", () => {
  it("opens Scribe realtime with the token (never the key), tuned like the bridge", () => {
    const url = new URL(scribeUrl("sutkn_1", ["Grok"]));
    expect(url.origin + url.pathname).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model_id: "scribe_v2_realtime",
      token: "sutkn_1",
      audio_format: "pcm_16000",
      commit_strategy: "vad",
      vad_silence_threshold_secs: "0.6",
      language_code: "en",
      keyterms: "Grok",
    });
    expect(url.toString()).not.toContain(KEY);
  });
});

describe("synthesize", () => {
  it("streams PCM for the answer in the owner's chosen voice", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200 }));
    const stream = await synthesize({ provider: "elevenlabs", apiKey: KEY, voiceId: "abcDEF123456" }, "March 30th.", undefined, fetchImpl);
    expect(stream).toBeInstanceOf(ReadableStream);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/abcDEF123456/stream?output_format=pcm_24000&enable_logging=false",
    );
    expect(init.headers).toEqual({ "xi-api-key": KEY, "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ text: "March 30th.", model_id: "eleven_flash_v2_5" });
  });

  it("reports failures, and lets a cancel through as itself", async () => {
    const settings = { provider: "elevenlabs" as const, apiKey: KEY, voiceId: DEFAULT_VOICE_ID };
    await expect(synthesize(settings, "hi", undefined, async () => reply(401, {}))).rejects.toMatchObject({ fatal: true });
    await expect(
      synthesize(settings, "hi", undefined, () => Promise.reject(new TypeError("offline"))),
    ).rejects.toMatchObject({ fatal: false });
    const abort = new AbortController();
    abort.abort();
    const aborted = new DOMException("aborted", "AbortError");
    await expect(synthesize(settings, "hi", abort.signal, () => Promise.reject(aborted))).rejects.toBe(aborted);
  });
});
