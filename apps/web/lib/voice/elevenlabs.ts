/**
 * The owner's own ElevenLabs account, used straight from their browser: the key lives in
 * this browser's localStorage and is only ever sent to api.elevenlabs.io.
 */

export const ELEVENLABS_API = "https://api.elevenlabs.io";
export const ELEVENLABS_WS = "wss://api.elevenlabs.io";
/** The bridge's defaults, so an agent sounds the same whichever door it came through. */
export const DEFAULT_VOICE_ID = "hpp4J3VqNfWAUOO0d1Us";
export const TTS_MODEL = "eleven_flash_v2_5";
export const TTS_RATE = 24_000;
export const VAD_SILENCE_SECONDS = 0.6;

const SETTINGS_KEY = "mooz.voice";
const KEY_PATTERN = /^[\x21-\x7e]{16,200}$/;
const VOICE_PATTERN = /^[A-Za-z0-9]{8,64}$/;

export interface VoiceSettings {
  apiKey: string;
  voiceId: string;
}

export class VoiceError extends Error {
  constructor(
    message: string,
    /** True when retrying can't help: a bad key, no credits left, terms not accepted. */
    readonly fatal: boolean,
  ) {
    super(message);
  }
}

/** Checks what the owner typed; returns an error message, or the settings to save. */
export function parseVoiceSettings(apiKey: string, voiceId: string): VoiceSettings | string {
  const key = apiKey.trim();
  const voice = voiceId.trim() || DEFAULT_VOICE_ID;
  if (!KEY_PATTERN.test(key)) return "That doesn't look like an ElevenLabs API key.";
  if (!VOICE_PATTERN.test(voice)) return "A voice ID is letters and numbers, from the voice's page in ElevenLabs.";
  return { apiKey: key, voiceId: voice };
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
    const saved = JSON.parse(store?.getItem(SETTINGS_KEY) ?? "null") as Partial<VoiceSettings> | null;
    if (typeof saved?.apiKey !== "string" || typeof saved.voiceId !== "string") return null;
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

async function failure(res: Response, what: string): Promise<VoiceError> {
  if (res.status === 401) return new VoiceError("ElevenLabs didn't accept your API key.", true);
  if (res.status === 402) return new VoiceError("Your ElevenLabs account is out of credits.", true);
  const detail = await res.text().catch(() => "");
  if (/quota|credits/i.test(detail)) return new VoiceError("Your ElevenLabs account is out of credits.", true);
  return new VoiceError(`ElevenLabs couldn't ${what} (HTTP ${res.status}).`, false);
}

/** A 15-minute, use-once token, so the key itself never goes into a WebSocket URL. */
export async function singleUseToken(
  apiKey: string,
  type: "realtime_scribe" | "tts_websocket",
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${ELEVENLABS_API}/v1/single-use-token/${type}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
  }).catch(() => null);
  if (!res) throw new VoiceError("Couldn't reach ElevenLabs.", false);
  if (!res.ok) throw await failure(res, "start listening");
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof body?.token !== "string" || !body.token) throw new VoiceError("ElevenLabs sent an odd reply.", false);
  return body.token;
}

/** Scribe realtime, 16 kHz PCM in, a committed transcript after each pause (like the bridge). */
export function scribeUrl(token: string, keyterms: readonly string[]): string {
  const params = new URLSearchParams({
    model_id: "scribe_v2_realtime",
    token,
    audio_format: "pcm_16000",
    commit_strategy: "vad",
    vad_silence_threshold_secs: String(VAD_SILENCE_SECONDS),
    language_code: "en",
    enable_logging: "false",
  });
  for (const term of keyterms) params.append("keyterms", term);
  return `${ELEVENLABS_WS}/v1/speech-to-text/realtime?${params}`;
}

/** Streams spoken audio for `text`, as 24 kHz 16-bit PCM bytes. */
export async function synthesize(
  settings: VoiceSettings,
  text: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadableStream<Uint8Array>> {
  const url =
    `${ELEVENLABS_API}/v1/text-to-speech/${encodeURIComponent(settings.voiceId)}/stream` +
    `?output_format=pcm_${TTS_RATE}&enable_logging=false`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "xi-api-key": settings.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: TTS_MODEL }),
    signal,
  }).catch((err: unknown) => {
    if (signal?.aborted) throw err;
    return null;
  });
  if (!res) throw new VoiceError("Couldn't reach ElevenLabs.", false);
  if (!res.ok || !res.body) throw await failure(res, "speak");
  return res.body;
}
