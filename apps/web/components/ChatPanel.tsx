"use client";

import type { useChat } from "@livekit/components-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAgent, participantLabel } from "@/lib/labels";
import { AgentBadge } from "./AgentBadge";

/** The meeting's chat (one `useChat` for the room, shared with the host's summary record). */
export function ChatPanel({ chat }: { chat: ReturnType<typeof useChat> }) {
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
          const who = { name: m.from?.name, attributes: m.from?.attributes ?? {} };
          const agent = isAgent(who);
          return (
            <li key={m.id} data-testid="chat-message" data-kind={agent ? "agent" : "human"} className="flex flex-col gap-1">
              <span className="flex items-center gap-2 text-xs text-muted">
                {agent && <AgentBadge />}
                <span data-testid="chat-sender">{participantLabel(who)}</span>
              </span>
              <span className="whitespace-pre-wrap break-words" data-testid="chat-text">
                {typeof m.message === "string" ? m.message : ""}
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
