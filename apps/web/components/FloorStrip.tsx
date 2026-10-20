"use client";

import { useParticipants, useRoomInfo } from "@livekit/components-react";
import { floorText, parseFloor } from "@/lib/floor-protocol";
import { participantLabel } from "@/lib/labels";

/** Which agent has the floor and who's next: agents answer one at a time. */
export function FloorStrip() {
  const { metadata } = useRoomInfo();
  const participants = useParticipants();
  const text = floorText(parseFloor(metadata), (identity) => {
    const p = participants.find((x) => x.identity === identity);
    return p ? participantLabel(p) : undefined;
  });
  if (!text) return null;
  return (
    <p data-testid="floor-strip" aria-live="polite" className="border-b border-zinc-800 bg-agent/10 px-4 py-1 text-xs text-zinc-200">
      {text}
    </p>
  );
}
