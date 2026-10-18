"use client";

import { ParticipantTile, useEnsureTrackRef, useParticipantAttributes } from "@livekit/components-react";
import { isAgent, participantLabel } from "@/lib/labels";
import { AgentBadge } from "./AgentBadge";

/** A video tile that makes agents unmistakable: badge, robot label, owner name. */
export function MoozTile() {
  const trackRef = useEnsureTrackRef();
  const { participant } = trackRef;
  const { attributes } = useParticipantAttributes({ participant });
  const who = { name: participant.name, attributes: attributes ?? {} };
  const agent = isAgent(who);

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
    </div>
  );
}
