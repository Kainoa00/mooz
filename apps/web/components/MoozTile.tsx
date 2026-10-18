"use client";

import { ParticipantTile, useEnsureTrackRef } from "@livekit/components-react";

/** A person's video tile. Agents never render here; they get an AgentCard. */
export function MoozTile() {
  const trackRef = useEnsureTrackRef();
  return (
    <div className="relative h-full w-full" data-testid="participant-tile" data-kind="human">
      <ParticipantTile trackRef={trackRef} />
    </div>
  );
}
