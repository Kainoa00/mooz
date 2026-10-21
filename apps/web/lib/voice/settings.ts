/**
 * The owner's voice settings for their connector agent, kept in this browser's localStorage:
 * either their own ElevenLabs account, or a speech server on this machine (VoiceStudio or
 * another OpenAI-compatible one). The mooz server never sees them.
 */

/** Both voices speak 16-bit mono PCM at this rate. */
export const TTS_RATE = 24_000;
export const DEFAULT_VOICE_ID = "hpp4J3VqNfWAUOO0d1Us";
export const DEFAULT_LOCAL_URL = "http://127.0.0.1:3900/v1";

const SETTINGS_KEY = "mooz.voice";
const KEY_PATTERN = /^[\x21-\x7e]{16,200}$/;
const VOICE_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const LOCAL_VOICE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
// Model ids can hold slashes (Speaches: "Systran/faster-whisper-small").
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,100}$/;
const PATH_PATTERN = /^[A-Za-z0-9/_.-]*$/;

export interface ElevenLabsVoice {
  provider: "elevenlabs";
  apiKey: string;
  voiceId: string;
}

export interface LocalVoice {
  provider: "local";
  /** Only this machine: http://127.0.0.1:PORT/... or http://localhost:PORT/... */
  baseUrl: string;
  voice: string;
  ttsModel: string;
  sttModel: string;
}

export type VoiceSettings = ElevenLabsVoice | LocalVoice;

export class VoiceError extends Error {
  constructor(
    message: string,
    /** True when retrying can't help: a bad key, no credits left, terms not accepted. */
    readonly fatal: boolean,
  ) {
    super(message);
  }
}

/** Checks what the owner typed for ElevenLabs; returns an error message, or the settings. */
export function parseVoiceSettings(apiKey: string, voiceId: string): ElevenLabsVoice | string {
  const key = apiKey.trim();
  const voice = voiceId.trim() || DEFAULT_VOICE_ID;
  if (!KEY_PATTERN.test(key)) return "That doesn't look like an ElevenLabs API key.";
  if (!VOICE_ID_PATTERN.test(voice)) return "A voice ID is letters and numbers, from the voice's page in ElevenLabs.";
  return { provider: "elevenlabs", apiKey: key, voiceId: voice };
}

/**
 * Checks a local speech server's settings. It must be on this machine: the page reaches it
 * from the owner's browser, and nothing else may be (the page's security policy allows only
 * this machine besides mooz, its LiveKit and ElevenLabs).
 */
export function parseLocalVoice(input: {
  baseUrl?: string;
  voice?: string;
  ttsModel?: string;
  sttModel?: string;
}): LocalVoice | string {
  const raw = (input.baseUrl ?? "").trim() || DEFAULT_LOCAL_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That isn't a web address, like http://127.0.0.1:3900/v1.";
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "http:" || !local || !url.port) {
    return "Use a speech server on this computer, like http://127.0.0.1:3900/v1 (with its port).";
  }
  if (url.username || url.password || url.search || url.hash || raw.includes("?") || raw.includes("#")) {
    return "Leave out passwords, ? and # from the speech server's address.";
  }
  if (!PATH_PATTERN.test(url.pathname)) return "The speech server's address has odd characters in it.";
  const voice = (input.voice ?? "").trim() || "default";
  const ttsModel = (input.ttsModel ?? "").trim() || "tts-1";
  const sttModel = (input.sttModel ?? "").trim() || "whisper-1";
  if (!LOCAL_VOICE_PATTERN.test(voice)) return "A voice name is letters, numbers, dots, dashes and colons.";
  if (!MODEL_PATTERN.test(ttsModel) || !MODEL_PATTERN.test(sttModel)) {
    return "A model name is letters, numbers, dots, dashes, colons and slashes.";
  }
  const baseUrl = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  return { provider: "local", baseUrl, voice, ttsModel, sttModel };
}

/** What identifies a voice setup (a problem with one setup doesn't carry over to another). */
export function voiceKey(settings: VoiceSettings): string {
  return JSON.stringify(settings);
}

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function local(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readVoiceSettings(store: KeyValueStore | null = local()): VoiceSettings | null {
  try {
    const saved = JSON.parse(store?.getItem(SETTINGS_KEY) ?? "null") as Record<string, unknown> | null;
    if (!saved || typeof saved !== "object") return null;
    if (saved.provider === "local") {
      const parsed = parseLocalVoice({
        baseUrl: String(saved.baseUrl ?? ""),
        voice: String(saved.voice ?? ""),
        ttsModel: String(saved.ttsModel ?? ""),
        sttModel: String(saved.sttModel ?? ""),
      });
      return typeof parsed === "string" ? null : parsed;
    }
    // Saved before there was a choice: ElevenLabs.
    if (typeof saved.apiKey !== "string" || typeof saved.voiceId !== "string") return null;
    const parsed = parseVoiceSettings(saved.apiKey, saved.voiceId);
    return typeof parsed === "string" ? null : parsed;
  } catch {
    return null;
  }
}

export function saveVoiceSettings(settings: VoiceSettings | null, store: KeyValueStore | null = local()): boolean {
  try {
    if (!store) return false;
    if (settings) store.setItem(SETTINGS_KEY, JSON.stringify(settings));
    else store.removeItem(SETTINGS_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Safari and iOS browsers can't reach this machine's http:// from an https page. */
export function localVoiceBlocked(page: { protocol: string; userAgent: string }): boolean {
  if (page.protocol !== "https:") return false;
  const ua = page.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua));
  const safari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS\/|FxiOS\/|Edg\/|EdgiOS\/|Firefox\//.test(ua);
  return ios || safari;
}
