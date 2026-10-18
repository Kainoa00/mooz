"use client";

import { useIsSpeaking, useParticipantAttributes } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { useState } from "react";
import { participantLabel } from "@/lib/labels";
import { AgentBadge } from "./AgentBadge";
import { useMeeting } from "./MeetingContext";

/**
 * Agents have no camera, so they get a compact card instead of a video tile:
 * robot avatar, owner label, a ring while speaking, and Remove for the host.
 */
export function AgentCard({ participant }: { participant: Participant }) {
  const { attributes } = useParticipantAttributes({ participant });
  const speaking = useIsSpeaking(participant);
  const { slug, isHost } = useMeeting();
  const [error, setError] = useState<string | null>(null);
  const label = participantLabel({ name: participant.name, attributes: attributes ?? {} });

  async function remove() {
    setError(null);
    const res = await fetch(`/api/rooms/${slug}/agents/${encodeURIComponent(participant.identity)}/remove`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not remove the agent. Try again.");
    }
  }

  return (
    <li
      data-testid="participant-tile"
      data-kind="agent"
      data-label={label}
      data-speaking={speaking}
      className="flex min-w-56 items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2"
    >
      <span
        aria-hidden
        className={`flex h-10 w-10 items-center justify-center rounded-full bg-agent/20 text-xl transition-shadow ${
          speaking ? "ring-2 ring-agent ring-offset-2 ring-offset-zinc-900" : ""
        }`}
      >
        🤖
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-white">{label}</span>
        <span className="flex items-center gap-2 text-xs text-zinc-400">
          <AgentBadge />
          {speaking ? "speaking" : "listening"}
        </span>
        {error && (
          <span role="alert" className="text-xs text-red-400">
            {error}
          </span>
        )}
      </span>
      {isHost && (
        <button
          type="button"
          onClick={remove}
          className="rounded-lg px-2 py-1 text-xs text-zinc-300 hover:bg-red-700 hover:text-white"
        >
          Remove agent
        </button>
      )}
    </li>
  );
}
