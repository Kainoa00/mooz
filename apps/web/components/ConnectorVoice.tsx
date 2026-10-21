"use client";

import { useParticipants, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isAgent } from "@/lib/labels";
import { NOTES_OPT_OUT_ATTRIBUTE } from "@/lib/notes-protocol";
import { LOCAL_GATE, SCRIBE_GATE } from "@/lib/voice/gate";
import { HearingHub } from "@/lib/voice/hearing";
import { LocalHearing, LocalVoiceOut, REQUEST_TIMEOUT_MS, testLocal, transcribeLocal } from "@/lib/voice/local";
import { scribeUrl, singleUseToken, synthesize } from "@/lib/voice/elevenlabs";
import { ScribeStream } from "@/lib/voice/scribe";
import {
  DEFAULT_LOCAL_URL,
  localVoiceBlocked,
  parseLocalVoice,
  parseVoiceSettings,
  readVoiceSettings,
  saveVoiceSettings,
  voiceKey,
  type VoiceError,
  type VoiceSettings,
} from "@/lib/voice/settings";
import { AgentSpeaker } from "@/lib/voice/speaker";

const CHANGED = "mooz:voice-settings";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The owner's voice settings in this browser, following changes from the dialog or other tabs. */
export function useVoiceSettings(): VoiceSettings | null {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      const s = readVoiceSettings();
      return s ? voiceKey(s) : "";
    },
    () => "",
  );
  return useMemo(() => (raw ? (JSON.parse(raw) as VoiceSettings) : null), [raw]);
}

function store(settings: VoiceSettings | null): boolean {
  const ok = saveVoiceSettings(settings);
  window.dispatchEvent(new Event(CHANGED));
  return ok;
}

const NO_STORAGE = "This browser won't save settings (private mode?), so voice can't stay on.";
const INPUT = "rounded-lg border border-zinc-500 bg-transparent px-2 py-1";

/**
 * Voice settings for the connector door, kept in this browser: the owner's own ElevenLabs
 * key, or a speech server on their computer.
 */
export function VoiceSettingsForm() {
  const settings = useVoiceSettings();
  const [provider, setProvider] = useState<VoiceSettings["provider"]>("elevenlabs");
  const [error, setError] = useState<string | null>(null);

  if (settings) {
    return (
      <div data-testid="voice-settings" className="flex flex-wrap items-center gap-2 rounded-lg bg-surface p-3 text-sm">
        <p data-testid="voice-status" className="flex-1">
          {settings.provider === "elevenlabs"
            ? `🎙️ Voice is on: your agent hears its name and speaks its answers, through your ElevenLabs account (key ending …${settings.apiKey.slice(-4)}).`
            : `🎙️ Voice is on: your agent hears its name and speaks its answers, through the speech server on this computer (${settings.baseUrl}, voice ${settings.voice}).`}
        </p>
        <button
          type="button"
          data-testid="voice-forget"
          onClick={() => store(null)}
          className="rounded-lg border border-zinc-400 px-2 py-1"
        >
          {settings.provider === "elevenlabs" ? "Turn off and forget the key" : "Turn off voice"}
        </button>
      </div>
    );
  }

  return (
    <div data-testid="voice-settings" className="flex flex-col gap-2 rounded-lg bg-surface p-3 text-sm">
      <p data-testid="voice-status" className="text-muted">
        Voice (optional). Without it, your agent hears <code>@{"{its name}"}</code> in chat and answers in chat. With
        voice it also hears its name said out loud and speaks, through your own ElevenLabs account or a speech server
        on this computer. The settings stay in this browser; mooz never sees them.
      </p>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">Voice through</legend>
        {(
          [
            ["elevenlabs", "ElevenLabs"],
            ["local", "Speech server on this computer"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-1">
            <input
              type="radio"
              name="voice-provider"
              data-testid={`voice-provider-${value}`}
              checked={provider === value}
              onChange={() => {
                setProvider(value);
                setError(null);
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {error && (
        <p role="alert" data-testid="voice-error" className="text-red-600">
          {error}
        </p>
      )}
      {provider === "elevenlabs" ? <ElevenLabsForm onError={setError} /> : <LocalForm onError={setError} />}
    </div>
  );
}

function ElevenLabsForm({ onError }: { onError: (message: string | null) => void }) {
  const [key, setKey] = useState("");
  const [voice, setVoice] = useState("");

  function save() {
    const parsed = parseVoiceSettings(key, voice);
    if (typeof parsed === "string") return onError(parsed);
    if (!store(parsed)) return onError(NO_STORAGE);
    onError(null);
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <p className="text-muted">
        The key goes only to ElevenLabs, which bills you for listening (only while people talk) and speaking.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          ElevenLabs API key
          <input
            data-testid="voice-key"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className={`w-56 ${INPUT}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          Voice ID (optional)
          <input data-testid="voice-id" value={voice} onChange={(e) => setVoice(e.target.value)} className={`w-44 ${INPUT}`} />
        </label>
        <button type="submit" data-testid="voice-save" disabled={!key.trim()} className="rounded-lg bg-accent px-3 py-1 text-white">
          Turn on voice
        </button>
      </div>
    </form>
  );
}

function LocalForm({ onError }: { onError: (message: string | null) => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [voice, setVoice] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [sttModel, setSttModel] = useState("");
  const [checking, setChecking] = useState(false);
  // A check can take a while (the browser's question waits on the owner): don't save after they've moved on.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const blocked = useSyncExternalStore(
    () => () => undefined,
    () => localVoiceBlocked({ protocol: window.location.protocol, userAgent: navigator.userAgent }),
    () => false,
  );

  async function save() {
    const parsed = parseLocalVoice({ baseUrl, voice, ttsModel, sttModel });
    if (typeof parsed === "string") return onError(parsed);
    onError(null);
    setChecking(true);
    let problem: string | null = null;
    try {
      await testLocal(parsed, window.location.origin);
    } catch (err) {
      problem = err instanceof Error ? err.message : "Couldn't check your speech server.";
    }
    if (!live.current) return;
    setChecking(false);
    if (problem) onError(problem);
    else if (!store(parsed)) onError(NO_STORAGE);
  }

  if (blocked) {
    return (
      <p data-testid="voice-local-blocked" className="text-muted">
        Safari, and every browser on iPhone and iPad, won&apos;t let this page reach a speech server on your computer.
        Use Chrome, Edge or Firefox on your computer for that, or ElevenLabs here.
      </p>
    );
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="text-muted">
        Everyone&apos;s speech goes to the server on this computer (VoiceStudio, or another OpenAI-compatible one), and
        nowhere else. When you turn it on, your browser may ask whether this site can use apps on your device: allow it.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          Server address
          <input
            data-testid="voice-local-url"
            value={baseUrl}
            placeholder={DEFAULT_LOCAL_URL}
            onChange={(e) => setBaseUrl(e.target.value)}
            className={`w-60 ${INPUT}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          Voice (optional)
          <input
            data-testid="voice-local-voice"
            value={voice}
            placeholder="default"
            onChange={(e) => setVoice(e.target.value)}
            className={`w-32 ${INPUT}`}
          />
        </label>
        <button type="submit" data-testid="voice-save" disabled={checking} className="rounded-lg bg-accent px-3 py-1 text-white">
          {checking ? "Checking…" : "Turn on voice"}
        </button>
      </div>
      <details>
        <summary className="cursor-pointer text-muted">More</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <label className="flex flex-col gap-1">
            Speech model
            <input
              data-testid="voice-local-tts-model"
              value={ttsModel}
              placeholder="tts-1"
              onChange={(e) => setTtsModel(e.target.value)}
              className={`w-44 ${INPUT}`}
            />
          </label>
          <label className="flex flex-col gap-1">
            Transcription model
            <input
              data-testid="voice-local-stt-model"
              value={sttModel}
              placeholder="whisper-1"
              onChange={(e) => setSttModel(e.target.value)}
              className={`w-56 ${INPUT}`}
            />
          </label>
        </div>
      </details>
    </form>
  );
}

/**
 * The agent's voice: speech scheduled into a WebAudio track that the agent publishes as its
 * mic. `phrases` are lines it says often ("Yes?"); a local server makes them ahead of time.
 */
export function openSpeaker(
  settings: VoiceSettings,
  onError: (error: VoiceError) => void,
  peopleTalking: () => boolean = () => false,
  phrases: readonly string[] = [],
) {
  const ctx = new AudioContext();
  void ctx.resume().catch(() => undefined);
  const destination = ctx.createMediaStreamDestination();
  const local = settings.provider === "local" ? new LocalVoiceOut(settings) : null;
  void local?.warm(phrases);
  const speaker = new AgentSpeaker({
    out: ctx,
    destination,
    synthesize:
      settings.provider === "local"
        ? (text, signal) => local!.synthesize(text, signal)
        : (text, signal) => synthesize(settings, text, signal),
    onError,
    peopleTalking,
    // A speech server on a CPU can take a while for each sentence; its requests have their own limit.
    ...(local ? { stallMs: REQUEST_TIMEOUT_MS } : {}),
  });
  return {
    speaker,
    track: destination.stream.getAudioTracks()[0],
    close() {
      local?.close();
      speaker.close();
      void ctx.close().catch(() => undefined);
    },
  };
}

interface Tap {
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
}

/** Who turns speech into text: Scribe streams through the owner's ElevenLabs account, or their own server. */
function openHearing(
  settings: VoiceSettings,
  name: string,
  sampleRate: number,
  onHeard: (identity: string, text: string) => void,
  onFatal: (message: string) => void,
): { hub: HearingHub; close: () => void } {
  if (settings.provider === "local") {
    const local = new LocalHearing((pcm, signal) => transcribeLocal(settings, pcm, signal));
    const hub = new HearingHub(sampleRate, (callbacks) => local.person(callbacks), onHeard, onFatal, LOCAL_GATE);
    return {
      hub,
      close() {
        hub.close();
        local.close();
      },
    };
  }
  const hub = new HearingHub(
    sampleRate,
    (callbacks) =>
      new ScribeStream({
        token: () => singleUseToken(settings.apiKey, "realtime_scribe"),
        url: (token) => scribeUrl(token, [name]),
        ...callbacks,
      }),
    onHeard,
    onFatal,
    SCRIBE_GATE,
  );
  return { hub, close: () => hub.close() };
}

/**
 * The agent's ears for speech: taps the meeting audio this tab already plays (people only,
 * never agents, and never anyone who chose to be left out) and transcribes it through the
 * owner's own speech service. Renders nothing.
 */
export function ConnectorHearing({
  settings,
  name,
  onHeard,
  onFatal,
}: {
  settings: VoiceSettings;
  name: string;
  onHeard: (identity: string, text: string) => void;
  onFatal: (message: string) => void;
}) {
  const tracks = useTracks([Track.Source.Microphone], { onlySubscribed: true });
  // Re-renders when someone opts out (or back in): their audio stops (or starts) going out.
  const leftOut = useParticipants()
    .filter((p) => p.attributes[NOTES_OPT_OUT_ATTRIBUTE] === "1")
    .map((p) => p.identity)
    .join(",");
  const people = useMemo(() => {
    const skip = new Set(leftOut.split(","));
    return tracks.flatMap((t) => {
      const media = t.publication.track?.mediaStreamTrack;
      if (!media || isAgent(t.participant) || skip.has(t.participant.identity)) return [];
      return [{ key: `${t.publication.trackSid}:${media.id}`, identity: t.participant.identity, media }];
    });
  }, [tracks, leftOut]);
  const handlers = useRef({ onHeard, onFatal });
  useEffect(() => {
    handlers.current = { onHeard, onFatal };
  });
  const audio = useRef<{ ctx: AudioContext; hub: HearingHub; sink: GainNode; ready: Promise<void>; taps: Map<string, Tap> } | null>(
    null,
  );
  // A new setup (key, server or voice) starts hearing afresh.
  const setup = voiceKey(settings);

  useEffect(() => {
    const ctx = new AudioContext();
    void ctx.resume().catch(() => undefined);
    // Worklets only run when connected toward the speakers; this one is silent.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    const hearing = openHearing(
      JSON.parse(setup) as VoiceSettings,
      name,
      ctx.sampleRate,
      (identity, text) => handlers.current.onHeard(identity, text),
      (message) => handlers.current.onFatal(message),
    );
    const current = {
      ctx,
      hub: hearing.hub,
      sink,
      ready: ctx.audioWorklet.addModule("/mooz-pcm-worklet.js"),
      taps: new Map<string, Tap>(),
    };
    audio.current = current;
    return () => {
      audio.current = null;
      hearing.close();
      for (const tap of current.taps.values()) untap(tap);
      void ctx.close().catch(() => undefined);
    };
  }, [setup, name]);

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    let stale = false;
    a.ready
      .then(() => {
        if (stale || audio.current !== a) return;
        const active = new Set(a.hub.sync(people));
        for (const [key, tap] of a.taps) {
          if (!active.has(key)) {
            untap(tap);
            a.taps.delete(key);
          }
        }
        for (const p of people) {
          if (!active.has(p.key) || a.taps.has(p.key)) continue;
          const source = a.ctx.createMediaStreamSource(new MediaStream([p.media]));
          const node = new AudioWorkletNode(a.ctx, "mooz-pcm", { channelCount: 1, channelCountMode: "explicit" });
          node.port.onmessage = (e: MessageEvent<Float32Array>) => a.hub.feed(p.key, e.data);
          source.connect(node);
          node.connect(a.sink);
          a.taps.set(p.key, { source, node });
        }
      })
      .catch(() => {
        if (!stale) handlers.current.onFatal("This browser couldn't start listening.");
      });
    return () => {
      stale = true;
    };
  }, [people, setup, name]);

  return null;
}

function untap(tap: Tap): void {
  tap.node.port.onmessage = null;
  tap.source.disconnect();
  tap.node.disconnect();
}
