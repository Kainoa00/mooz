"use client";

import { useParticipants, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isAgent } from "@/lib/labels";
import { NOTES_OPT_OUT_ATTRIBUTE } from "@/lib/notes-protocol";
import {
  parseVoiceSettings,
  readVoiceSettings,
  saveVoiceSettings,
  scribeUrl,
  singleUseToken,
  synthesize,
  type VoiceError,
  type VoiceSettings,
} from "@/lib/voice/elevenlabs";
import { ScribeHub, ScribeStream } from "@/lib/voice/scribe";
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
      return s ? `${s.apiKey}\n${s.voiceId}` : "";
    },
    () => "",
  );
  return useMemo(() => {
    if (!raw) return null;
    const [apiKey, voiceId] = raw.split("\n");
    return { apiKey, voiceId };
  }, [raw]);
}

function store(settings: VoiceSettings | null): boolean {
  const ok = saveVoiceSettings(settings);
  window.dispatchEvent(new Event(CHANGED));
  return ok;
}

/** Voice settings for the connector door: the owner's own ElevenLabs key, kept in this browser. */
export function VoiceSettingsForm() {
  const settings = useVoiceSettings();
  const [key, setKey] = useState("");
  const [voice, setVoice] = useState("");
  const [error, setError] = useState<string | null>(null);

  function save() {
    const parsed = parseVoiceSettings(key, voice);
    if (typeof parsed === "string") {
      setError(parsed);
      return;
    }
    if (!store(parsed)) {
      setError("This browser won't save settings (private mode?), so voice can't stay on.");
      return;
    }
    setError(null);
    setKey("");
    setVoice("");
  }

  if (settings) {
    return (
      <div data-testid="voice-settings" className="flex flex-wrap items-center gap-2 rounded-lg bg-surface p-3 text-sm">
        <p data-testid="voice-status" className="flex-1">
          🎙️ Voice is on: your agent hears its name and speaks its answers, through your ElevenLabs account (key
          ending …{settings.apiKey.slice(-4)}).
        </p>
        <button
          type="button"
          data-testid="voice-forget"
          onClick={() => store(null)}
          className="rounded-lg border border-zinc-400 px-2 py-1"
        >
          Turn off and forget the key
        </button>
      </div>
    );
  }

  return (
    <form
      data-testid="voice-settings"
      className="flex flex-col gap-2 rounded-lg bg-surface p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <p data-testid="voice-status" className="text-muted">
        Voice (optional). Without it, your agent hears <code>@{"{its name}"}</code> in chat and answers in chat. With
        your ElevenLabs key it also hears its name said out loud and speaks. The key stays in this browser and goes
        only to ElevenLabs, which bills you for listening (only while people talk) and speaking.
      </p>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          ElevenLabs API key
          <input
            data-testid="voice-key"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="w-56 rounded-lg border border-zinc-500 bg-transparent px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          Voice ID (optional)
          <input
            data-testid="voice-id"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            className="w-44 rounded-lg border border-zinc-500 bg-transparent px-2 py-1"
          />
        </label>
        <button type="submit" data-testid="voice-save" disabled={!key.trim()} className="rounded-lg bg-accent px-3 py-1 text-white">
          Turn on voice
        </button>
      </div>
    </form>
  );
}

/** The agent's voice: speech scheduled into a WebAudio track that the agent publishes as its mic. */
export function openSpeaker(settings: VoiceSettings, onError: (error: VoiceError) => void) {
  const ctx = new AudioContext();
  void ctx.resume().catch(() => undefined);
  const destination = ctx.createMediaStreamDestination();
  const speaker = new AgentSpeaker({
    out: ctx,
    destination,
    synthesize: (text, signal) => synthesize(settings, text, signal),
    onError,
  });
  return {
    speaker,
    track: destination.stream.getAudioTracks()[0],
    close() {
      speaker.close();
      void ctx.close().catch(() => undefined);
    },
  };
}

interface Tap {
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
}

/**
 * The agent's ears for speech: taps the meeting audio this tab already plays (people only,
 * never agents, and never anyone who chose to be left out) and transcribes it through the
 * owner's ElevenLabs account. Renders nothing.
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
  const audio = useRef<{ ctx: AudioContext; hub: ScribeHub; sink: GainNode; ready: Promise<void>; taps: Map<string, Tap> } | null>(
    null,
  );

  useEffect(() => {
    const ctx = new AudioContext();
    void ctx.resume().catch(() => undefined);
    // Worklets only run when connected toward the speakers; this one is silent.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    const hub = new ScribeHub(
      ctx.sampleRate,
      (callbacks) =>
        new ScribeStream({
          token: () => singleUseToken(settings.apiKey, "realtime_scribe"),
          url: (token) => scribeUrl(token, [name]),
          ...callbacks,
        }),
      (identity, text) => handlers.current.onHeard(identity, text),
      (message) => handlers.current.onFatal(message),
    );
    const current = { ctx, hub, sink, ready: ctx.audioWorklet.addModule("/mooz-pcm-worklet.js"), taps: new Map<string, Tap>() };
    audio.current = current;
    return () => {
      audio.current = null;
      hub.close();
      for (const tap of current.taps.values()) untap(tap);
      void ctx.close().catch(() => undefined);
    };
  }, [settings.apiKey, name]);

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
  }, [people, settings.apiKey, name]);

  return null;
}

function untap(tap: Tap): void {
  tap.node.port.onmessage = null;
  tap.source.disconnect();
  tap.node.disconnect();
}
