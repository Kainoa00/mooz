"use client";

import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, type Participant } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { decodeLegacyChat } from "@/lib/chat-decode";
import { CHAT_TOPIC, LEGACY_CHAT_TOPIC, addLine, resolveSenders, shownLines, type ChatLine, type ShownLine } from "@/lib/chat-log";
import { isAgent, participantLabel } from "@/lib/labels";
import { AgentBadge } from "./AgentBadge";

export type ChatMessage = ShownLine<Participant>;

export interface MeetingChat {
  /** Only messages whose sender this tab knows (lib/chat-log.ts). */
  chatMessages: readonly ChatMessage[];
  send: (text: string) => Promise<void>;
  isSending: boolean;
}

/**
 * The meeting's chat, for the panel and the host's summary record. Not `useChat`: that looks
 * a sender up once, as their message arrives, and makes it nobody's if LiveKit hasn't announced
 * them yet. Here a message waits for its sender.
 */
export function useMeetingChat(): MeetingChat {
  const room = useRoomContext();
  const [lines, setLines] = useState<readonly ChatLine<Participant>[]>([]);
  const [isSending, setSending] = useState(false);

  useEffect(() => {
    const find = (identity: string) => room.getParticipantByIdentity(identity);
    const add = (line: ChatLine<Participant>) => setLines((prev) => addLine(prev, line, find));
    const resolve = () => setLines((prev) => resolveSenders(prev, find));
    room.registerTextStreamHandler(CHAT_TOPIC, async (reader, { identity }) => {
      let message: string;
      try {
        message = await reader.readAll();
      } catch {
        return; // the stream was cut off
      }
      const { id, timestamp, attributes } = reader.info;
      add({ id, identity, message, timestamp, attributes });
    });
    const onData = (payload: Uint8Array, _from?: Participant, _kind?: unknown, topic?: string, _e?: unknown, identity?: string) => {
      if (topic !== LEGACY_CHAT_TOPIC) return;
      const chat = decodeLegacyChat(payload);
      if (chat) add({ ...chat, identity: identity ?? "" }); // no identity: the server's, and nobody's
    };
    // Whoever LiveKit announces may have spoken already.
    room.on(RoomEvent.DataReceived, onData).on(RoomEvent.ParticipantConnected, resolve);
    return () => {
      room.unregisterTextStreamHandler(CHAT_TOPIC);
      room.off(RoomEvent.DataReceived, onData).off(RoomEvent.ParticipantConnected, resolve);
    };
  }, [room]);

  const send = useCallback(
    async (text: string) => {
      setSending(true);
      try {
        const me = room.localParticipant;
        const { id } = await me.sendText(text, { topic: CHAT_TOPIC });
        const timestamp = Date.now();
        setLines((prev) => addLine(prev, { id, identity: me.identity, message: text, timestamp, from: me }, () => me));
        // As useChat does, for LiveKit clients too old for text streams (newer ones skip it).
        const legacy = new TextEncoder().encode(JSON.stringify({ id, timestamp, message: text, ignoreLegacy: true }));
        await me.publishData(legacy, { reliable: true, topic: LEGACY_CHAT_TOPIC }).catch(() => undefined);
      } finally {
        setSending(false);
      }
    },
    [room],
  );

  const chatMessages = useMemo(() => shownLines(lines), [lines]);
  return useMemo(() => ({ chatMessages, send, isSending }), [chatMessages, send, isSending]);
}

/** The meeting's chat (one `useMeetingChat` for the room, shared with the host's summary record). */
export function ChatPanel({ chat }: { chat: MeetingChat }) {
  const { chatMessages, send, isSending } = chat;
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chatMessages.length]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    await send(text);
    setDraft("");
  }

  return (
    <section aria-label="Chat" className="flex min-h-0 flex-1 flex-col">
      <ol ref={listRef} data-testid="chat-messages" className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {chatMessages.map((m) => {
          const who = { name: m.from.name, attributes: m.from.attributes };
          const agent = isAgent(who);
          return (
            <li key={`${m.identity}\n${m.id}`} data-testid="chat-message" data-kind={agent ? "agent" : "human"} className="flex flex-col gap-1">
              <span className="flex items-center gap-2 text-xs text-muted">
                {agent && <AgentBadge />}
                <span data-testid="chat-sender">{participantLabel(who)}</span>
              </span>
              <span className="whitespace-pre-wrap break-words" data-testid="chat-text">
                {m.message}
              </span>
            </li>
          );
        })}
      </ol>
      <form onSubmit={submit} className="flex gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
        <input
          aria-label="Message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message · @Name asks an agent"
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-transparent px-3 py-2 text-sm"
        />
        <button type="submit" disabled={isSending} className="rounded-lg bg-accent px-3 py-2 text-sm text-white">
          Send
        </button>
      </form>
    </section>
  );
}
