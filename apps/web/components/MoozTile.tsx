"use client";

import { ParticipantTile, useEnsureTrackRef, useParticipantAttributes } from "@livekit/components-react";
import { useState } from "react";
import { isAgent, participantLabel } from "@/lib/labels";
import { AgentBadge } from "./AgentBadge";
import { useMeeting } from "./MeetingContext";

/** A video tile that makes agents unmistakable: badge, robot label, owner name. */
export function MoozTile() {
  const trackRef = useEnsureTrackRef();
  const { participant } = trackRef;
  const { attributes } = useParticipantAttributes({ participant });
  const who = { name: participant.name, attributes: attributes ?? {} };
  const agent = isAgent(who);
  const { slug, isHost } = useMeeting();
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function remove() {
    setRemoveError(null);
    const res = await fetch(`/api/rooms/${slug}/agents/${encodeURIComponent(participant.identity)}/remove`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setRemoveError(body?.error?.message ?? "Could not remove the agent. Try again.");
    }
  }

  return (
    <div
      className="relative h-full w-full"
      data-testid="participant-tile"
      data-kind={agent ? "agent" : "human"}
      data-label={participantLabel(who)}
    >
      <ParticipantTile trackRef={trackRef} />
      {agent && (
        <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-2">
          <AgentBadge />
          <span className="rounded bg-black/60 px-2 py-0.5 text-sm text-white">{participantLabel(who)}</span>
        </div>
      )}
      {agent && isHost && (
        <button
          type="button"
          onClick={remove}
          className="absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 text-xs text-white hover:bg-red-700"
        >
          Remove agent
        </button>
      )}
      {removeError && (
        <p role="alert" className="absolute bottom-2 left-2 rounded bg-red-700 px-2 py-0.5 text-xs text-white">
          {removeError}
        </p>
      )}
    </div>
  );
}
