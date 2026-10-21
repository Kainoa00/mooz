import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_URL,
  localVoiceBlocked,
  parseLocalVoice,
  readVoiceSettings,
  saveVoiceSettings,
  voiceKey,
} from "./settings";

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("parseLocalVoice", () => {
  it("defaults to VoiceStudio on this machine", () => {
    expect(parseLocalVoice({})).toEqual({
      provider: "local",
      baseUrl: DEFAULT_LOCAL_URL,
      voice: "default",
      ttsModel: "tts-1",
      sttModel: "whisper-1",
    });
  });

  it("takes another local server, its voice and models", () => {
    expect(
      parseLocalVoice({ baseUrl: " http://localhost:8000/v1/ ", voice: "af_bella", sttModel: "Systran/faster-whisper-small" }),
    ).toMatchObject({ baseUrl: "http://localhost:8000/v1", voice: "af_bella", sttModel: "Systran/faster-whisper-small" });
  });

  it.each([
    "https://speech.example.com/v1", // not this machine
    "http://speech.example.com:3900/v1",
    "http://192.168.1.5:3900/v1",
    "http://127.0.0.1/v1", // no port
    "ws://127.0.0.1:3900/v1",
    "http://user:pass@127.0.0.1:3900/v1",
    "http://127.0.0.1:3900/v1?x=1",
    "http://127.0.0.1:3900/v1#frag",
    "http://127.0.0.1:3900/v1/<script>",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %j", (baseUrl) => {
    expect(typeof parseLocalVoice({ baseUrl })).toBe("string");
  });

  it.each([{ voice: "a b" }, { voice: "x".repeat(65) }, { ttsModel: "tts 1" }, { sttModel: "w;1" }])("refuses %j", (input) => {
    expect(typeof parseLocalVoice(input)).toBe("string");
  });
});

describe("saved voice settings", () => {
  it("round-trips either kind", () => {
    const store = memoryStore();
    const local = parseLocalVoice({ voice: "af_bella" });
    if (typeof local === "string") throw new Error(local);
    expect(saveVoiceSettings(local, store)).toBe(true);
    expect(readVoiceSettings(store)).toEqual(local);
    saveVoiceSettings({ provider: "elevenlabs", apiKey: "sk_" + "a".repeat(30), voiceId: "abcdefgh12" }, store);
    expect(readVoiceSettings(store)).toMatchObject({ provider: "elevenlabs", voiceId: "abcdefgh12" });
  });

  it("reads settings saved before there was a choice as ElevenLabs", () => {
    const store = memoryStore();
    store.setItem("mooz.voice", JSON.stringify({ apiKey: "sk_" + "a".repeat(30), voiceId: "abcdefgh12" }));
    expect(readVoiceSettings(store)).toMatchObject({ provider: "elevenlabs", apiKey: "sk_" + "a".repeat(30) });
  });

  it("ignores a saved local server that isn't on this machine", () => {
    const store = memoryStore();
    store.setItem("mooz.voice", JSON.stringify({ provider: "local", baseUrl: "https://evil.example/v1", voice: "x" }));
    expect(readVoiceSettings(store)).toBeNull();
  });

  it("tells setups apart", () => {
    const a = parseLocalVoice({ voice: "one" });
    const b = parseLocalVoice({ voice: "two" });
    if (typeof a === "string" || typeof b === "string") throw new Error("bad");
    expect(voiceKey(a)).not.toBe(voiceKey(b));
  });
});

describe("localVoiceBlocked", () => {
  const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
  const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:153.0) Gecko/20100101 Firefox/153.0";
  const IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1";

  it("is Safari and every iOS browser, on https pages only", () => {
    expect(localVoiceBlocked({ protocol: "https:", userAgent: SAFARI })).toBe(true);
    expect(localVoiceBlocked({ protocol: "https:", userAgent: IOS_CHROME })).toBe(true);
    expect(localVoiceBlocked({ protocol: "https:", userAgent: CHROME })).toBe(false);
    expect(localVoiceBlocked({ protocol: "https:", userAgent: FIREFOX })).toBe(false);
    expect(localVoiceBlocked({ protocol: "http:", userAgent: SAFARI })).toBe(false);
  });
});
