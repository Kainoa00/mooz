"use client";

import { DisconnectReason, Room, RoomEvent, type TextStreamReader } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectorEars } from "@/lib/connector-ears";
import {
  APP_LABEL,
  CONNECTOR_TOPIC,
  assistantLink,
  assistantPrompt,
  parseAnswerPacket,
  type AnswerPacket,
  type AssistantApp,
} from "@/lib/connector-protocol";
import { errorMessage, readBody } from "@/lib/fetch-json";
import { isAgent } from "@/lib/labels";

/** The connector this tab brought into the meeting (kept across reloads in sessionStorage). */
export interface BroughtConnector {
  requestId: string;
  name: string;
  app: AssistantApp;
}

/** What the agent can do with its voice (browser voice, when the owner set it up). */
export interface AgentVoice {
  speak(text: string): void;
}

type Phase = "waiting" | "in" | "denied" | "expired" | "removed" | "failed";

interface Asked {
  id: string;
  askerName: string;
  text: string;
}

const FILLER = "One sec, checking.";
const STATUS_POLL_MS = 2000;
const ANSWER_POLL_MS = 3000;
const REVIEW_KEY = "mooz.connector.review";
const MAX_CHAT_CHARS = 4000;

const storage = {
  get(key: string): string | null {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // private mode: the worst case is an answer posted twice after a reload
    }
  },
};

/** Answers this tab already posted, so a reload doesn't post them again. */
function readDelivered(key: string): Set<string> {
  try {
    const ids: unknown = JSON.parse(storage.get(key) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function readReviewSetting(): boolean {
  try {
    return window.localStorage.getItem(REVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The connector agent, run from its owner's tab: a second LiveKit connection as the agent
 * once the host approves it. It listens to the chat, queues questions for the owner's
 * assistant app, shows the owner a one-tap prompt for each, and posts (and speaks) the
 * answers the server hands it.
 */
export function ConnectorAgent({
  slug,
  connector,
  voice,
  onEnded,
}: {
  slug: string;
  connector: BroughtConnector;
  voice?: AgentVoice;
  onEnded: () => void;
}) {
  const base = `/api/rooms/${slug}/connector-requests/${connector.requestId}`;
  const deliveredKey = `mooz.connector.delivered.${connector.requestId}`;
  const [phase, setPhase] = useState<Phase>("waiting");
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<Asked[]>([]);
  const [reviewing, setReviewing] = useState<AnswerPacket[]>([]);
  const [review, setReview] = useState(readReviewSetting);
  const roomRef = useRef<Room | null>(null);
  const earsRef = useRef<ConnectorEars | null>(null);
  const delivered = useRef<Set<string> | null>(null);
  const reviewRef = useRef(review);
  const voiceRef = useRef(voice);

  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  const say = useCallback(async (text: string, replyTo: string, sources: string[] = []) => {
    const room = roomRef.current;
    if (!room) return;
    const attributes: Record<string, string> = { reply_to: replyTo };
    if (sources.length) attributes.sources = sources.join(",");
    await room.localParticipant.sendText(text, { topic: "lk.chat", attributes });
    earsRef.current?.said(text, replyTo);
  }, []);

  const post = useCallback(
    async (packet: AnswerPacket) => {
      await say(packet.details ? `${packet.spoken}\n\n${packet.details}` : packet.spoken, packet.reply_to, packet.sources);
      voiceRef.current?.speak(packet.spoken);
    },
    [say],
  );

  const receive = useCallback(
    (packet: AnswerPacket) => {
      const seen = (delivered.current ??= readDelivered(deliveredKey));
      if (seen.has(packet.id)) return;
      seen.add(packet.id);
      storage.set(deliveredKey, JSON.stringify([...seen].slice(-50)));
      setAsked((list) => list.filter((q) => q.id !== packet.id));
      if (reviewRef.current) setReviewing((list) => [...list, packet]);
      else void post(packet);
    },
    [deliveredKey, post],
  );

  // 1. Wait for the host to decide.
  useEffect(() => {
    if (approved || phase !== "waiting") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const res = await fetch(base, { cache: "no-store" }).catch(() => null);
      const body = res ? await readBody(res) : null;
      if (stopped) return;
      const status = body?.status;
      if (status === "approved") setApproved(true);
      else if (status === "denied") setPhase("denied");
      else if (status === "revoked") setPhase("removed");
      else if (status === "expired") setPhase("expired");
      else timer = setTimeout(tick, STATUS_POLL_MS);
    };
    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [approved, phase, base]);

  // 2. Once approved, join as the agent and listen.
  useEffect(() => {
    if (!approved) return;
    let cancelled = false;
    const room = new Room();

    async function onChat(reader: TextStreamReader, identity: string) {
      let text: string;
      try {
        text = (await reader.readAll()).slice(0, MAX_CHAT_CHARS);
      } catch {
        return;
      }
      const from = room.remoteParticipants.get(identity);
      const ears = earsRef.current;
      if (!from || !ears) return;
      const attrs = reader.info.attributes ?? {};
      const kind = isAgent(from) ? "agent" : "human";
      const heard = ears.hear({
        identity,
        person: kind === "agent" ? (from.attributes.owner_id ?? identity) : identity,
        kind,
        text,
        via: "chat",
        replyTo: attrs.reply_to,
        sources: attrs.sources?.split(",").filter(Boolean),
      });
      if (!heard) return;
      if (heard.kind === "wake") {
        await say("Yes?", heard.replyTo);
        return;
      }
      await say(FILLER, heard.replyTo);
      const res = await fetch(`${base}/questions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ asker: heard.asker, text: heard.text, lines: ears.snapshot() }),
      }).catch(() => null);
      const body = res ? await readBody(res) : null;
      const question = body?.question as { id: string; text: string; asker: { name: string } } | undefined;
      if (res?.ok && question) {
        setAsked((list) => [...list, { id: question.id, askerName: question.asker.name, text: question.text }]);
      } else {
        setError(errorMessage(body, "Could not pass a question to your assistant."));
      }
    }

    (async () => {
      const res = await fetch(`${base}/token`, { method: "POST" }).catch(() => null);
      const body = res ? await readBody(res) : null;
      if (cancelled) return;
      if (!res?.ok || !body) {
        setError(errorMessage(body, "Could not bring your agent in."));
        setPhase(res?.status === 409 ? "removed" : "failed");
        return;
      }
      const { token, url, identity, name } = body as { token: string; url: string; identity: string; name: string };
      earsRef.current = new ConnectorEars(name, identity);
      room.registerTextStreamHandler("lk.chat", (reader, info) => void onChat(reader, info.identity));
      room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (participant || topic !== CONNECTOR_TOPIC) return; // only the server sends answers
        const packet = parseAnswerPacket(payload);
        if (packet) receive(packet);
      });
      room.on(RoomEvent.Disconnected, (reason) => {
        if (cancelled) return;
        roomRef.current = null;
        setPhase(reason === DisconnectReason.PARTICIPANT_REMOVED ? "removed" : "failed");
      });
      await room.connect(url, token, { autoSubscribe: false });
      if (cancelled) {
        await room.disconnect();
        return;
      }
      roomRef.current = room;
      setPhase("in");
    })().catch(() => {
      if (!cancelled) {
        setError("Could not connect your agent.");
        setPhase("failed");
      }
    });

    return () => {
      cancelled = true;
      roomRef.current = null;
      void room.disconnect();
    };
  }, [approved, base, receive, say]);

  // 3. In case an answer's packet never arrived (or this tab reloaded): pick it up from the server.
  useEffect(() => {
    if (phase !== "in") return;
    const timer = setInterval(async () => {
      const res = await fetch(`${base}/questions`, { cache: "no-store" }).catch(() => null);
      const body = res ? await readBody(res) : null;
      const questions = (body?.questions ?? []) as { answer?: AnswerPacket }[];
      for (const q of questions) if (q.answer) receive(q.answer);
    }, ANSWER_POLL_MS);
    return () => clearInterval(timer);
  }, [phase, base, receive]);

  function toggleReview(on: boolean) {
    reviewRef.current = on;
    setReview(on);
    try {
      window.localStorage.setItem(REVIEW_KEY, on ? "1" : "0");
    } catch {
      // the switch still works for this page
    }
  }

  const label = APP_LABEL[connector.app];
  const status: Record<Phase, string> = {
    waiting: approved ? `Bringing ${connector.name} in…` : `Waiting for the host to let ${connector.name} in…`,
    in: `${connector.name} is in the meeting. When someone asks it something, it shows up here.`,
    denied: `The host didn't let ${connector.name} in.`,
    expired: "The request expired. Try again from Bring my agent.",
    removed: `${connector.name} isn't in the meeting anymore.`,
    failed: error ?? "Something went wrong with your agent.",
  };
  const ended = phase === "denied" || phase === "expired" || phase === "removed" || phase === "failed";

  return (
    <section
      aria-label={`Your ${connector.name}`}
      data-testid="connector-panel"
      data-phase={phase}
      className="fixed bottom-20 left-4 z-40 flex max-h-[60vh] w-80 flex-col gap-2 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm text-white shadow-lg"
    >
      <p data-testid="connector-status">🤖 {status[phase]}</p>
      {phase === "in" && (
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            data-testid="review-answers"
            checked={review}
            onChange={(e) => toggleReview(e.target.checked)}
          />
          Review answers before they&apos;re spoken
        </label>
      )}
      {phase === "in" && error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
      {asked.map((q) => (
        <QuestionCard
          key={q.id}
          question={q}
          app={connector.app}
          appLabel={label}
          answerUrl={`${base}/questions/${q.id}/answer`}
          onDismiss={() => setAsked((list) => list.filter((x) => x.id !== q.id))}
        />
      ))}
      {reviewing.map((p) => (
        <div key={p.id} data-testid="answer-review" className="flex flex-col gap-2 rounded-lg border border-agent/60 p-2">
          <p className="text-xs text-zinc-300">Your assistant answered:</p>
          <p>{p.spoken}</p>
          {p.details && <p className="whitespace-pre-wrap break-words text-xs text-zinc-300">{p.details}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg bg-agent px-3 py-1"
              onClick={() => {
                setReviewing((list) => list.filter((x) => x.id !== p.id));
                void post(p);
              }}
            >
              Post it
            </button>
            <button
              type="button"
              className="rounded-lg border border-zinc-500 px-3 py-1"
              onClick={() => setReviewing((list) => list.filter((x) => x.id !== p.id))}
            >
              Discard
            </button>
          </div>
        </div>
      ))}
      {ended && (
        <button type="button" onClick={onEnded} className="self-end rounded-lg border border-zinc-500 px-3 py-1 text-xs">
          Close
        </button>
      )}
    </section>
  );
}

function QuestionCard({
  question,
  app,
  appLabel,
  answerUrl,
  onDismiss,
}: {
  question: Asked;
  app: AssistantApp;
  appLabel: string;
  answerUrl: string;
  onDismiss: () => void;
}) {
  const prompt = assistantPrompt(question.id);
  const link = assistantLink(app, prompt);
  const [copied, setCopied] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    await navigator.clipboard?.writeText(prompt).catch(() => undefined);
    setCopied(true);
  }

  async function submit() {
    setError(null);
    const res = await fetch(answerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spoken: answer }),
    }).catch(() => null);
    if (!res?.ok) setError(errorMessage(res ? await readBody(res) : null, "Could not post the answer."));
  }

  return (
    <div data-testid="connector-question" data-question-id={question.id} className="flex flex-col gap-2 rounded-lg border border-zinc-700 p-2">
      <p>
        <strong>{question.askerName}</strong> asks: <span data-testid="connector-question-text">{question.text}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="ask-assistant"
            className="rounded-lg bg-agent px-3 py-1 text-white"
          >
            Ask {appLabel} ↗
          </a>
        )}
        <button type="button" data-testid="copy-prompt" onClick={copy} className="rounded-lg border border-zinc-500 px-3 py-1">
          {copied ? "Copied" : "Copy prompt"}
        </button>
        <button type="button" onClick={() => setPasting((v) => !v)} className="rounded-lg border border-zinc-500 px-3 py-1">
          Paste the answer
        </button>
        <button type="button" onClick={onDismiss} className="rounded-lg px-2 py-1 text-zinc-400">
          Dismiss
        </button>
      </div>
      {pasting && (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label="The answer"
            data-testid="paste-answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={3}
            className="rounded-lg border border-zinc-600 bg-transparent p-2"
          />
          <button type="button" onClick={submit} disabled={!answer.trim()} className="self-start rounded-lg bg-agent px-3 py-1">
            Post the answer
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
