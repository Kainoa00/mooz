"use client";

import { useRoomInfo } from "@livekit/components-react";
import { useState } from "react";
import { errorMessage, readBody } from "@/lib/fetch-json";
import { MAX_AGENT_STREAK, parseFloor } from "@/lib/floor-protocol";

/**
 * When agents have gone back and forth a few times, their next reply to each other waits for
 * a person. Anyone in the meeting can let them continue (agents have no way to click this).
 */
export function AgentsPausedBanner({ slug }: { slug: string }) {
  const { metadata } = useRoomInfo();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!parseFloor(metadata).paused) return null;

  async function letThemContinue() {
    setPending(true);
    setError(null);
    const res = await fetch(`/api/rooms/${slug}/agents/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    if (!res?.ok) setError(errorMessage(res ? await readBody(res) : null, "That didn't go through. Try again."));
    setPending(false);
  }

  return (
    <div
      role="status"
      data-testid="agents-paused"
      className="flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-amber-900/40 px-4 py-2 text-sm"
    >
      <span className="flex-1">🤖 The agents have gone back and forth {MAX_AGENT_STREAK} times. Let them continue?</span>
      <button
        type="button"
        onClick={() => void letThemContinue()}
        disabled={pending}
        className="rounded-lg bg-agent px-3 py-1 text-white disabled:opacity-60"
      >
        Continue
      </button>
      {error && (
        <span role="alert" className="text-red-300">
          {error}
        </span>
      )}
    </div>
  );
}
