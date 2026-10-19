"use client";

import {
  useConnectionState,
  useDataChannel,
  useLocalParticipant,
  useParticipantAttributes,
  useParticipants,
  useRoomContext,
} from "@livekit/components-react";
import { ConnectionState, type Participant } from "livekit-client";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, readBody } from "@/lib/fetch-json";
import { isAgent, ownedName } from "@/lib/labels";
import {
  MOOZ_TOPIC,
  NOTES_OPT_OUT_ATTRIBUTE,
  NOTES_QUERY,
  notesBannerText,
  parseNotesAnnouncement,
} from "@/lib/notes-protocol";

/**
 * Shown to everyone while any agent says it is keeping notes, or a connector agent (which can
 * pass the meeting to its owner's assistant app) is here, with a way to be left out of both.
 * Announcements count only from agents, and only for themselves (LiveKit stamps the sender);
 * a connector agent's door is set by the server in its token.
 */
export function NotesBanner({ slug }: { slug: string }) {
  const [keeping, setKeeping] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onMessage = useCallback((msg: { payload: Uint8Array; from?: Participant }) => {
    const from = msg.from;
    if (!from || !isAgent(from)) return;
    const state = parseNotesAnnouncement(msg.payload);
    if (!state) return;
    setKeeping((prev) => {
      const next = new Set(prev);
      if (state === "on") next.add(from.identity);
      else next.delete(from.identity);
      return next;
    });
  }, []);
  useDataChannel(MOOZ_TOPIC, onMessage);

  // On joining and after every reconnect, ask agents directly: an announcement sent while we
  // were away would otherwise be missed.
  const room = useRoomContext();
  const connection = useConnectionState();
  useEffect(() => {
    if (connection !== ConnectionState.Connected) return;
    room.localParticipant.publishData(NOTES_QUERY, { reliable: true, topic: MOOZ_TOPIC }).catch(() => {});
  }, [connection, room]);

  // An agent that left is no longer keeping notes, whatever it last said.
  const participants = useParticipants();
  const keepers = participants.filter((p) => isAgent(p) && keeping.has(p.identity));
  const connectors = participants.filter((p) => isAgent(p) && p.attributes.door === "connector");
  const { localParticipant } = useLocalParticipant();
  const { attributes } = useParticipantAttributes({ participant: localParticipant });
  const optedOut = attributes?.[NOTES_OPT_OUT_ATTRIBUTE] === "1";

  async function setOptOut(optOut: boolean) {
    setPending(true);
    setError(null);
    const res = await fetch(`/api/rooms/${slug}/notes-opt-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optOut, identity: localParticipant.identity }),
    }).catch(() => null);
    if (!res?.ok) setError(errorMessage(res ? await readBody(res) : null, "That didn't go through. Try again."));
    setPending(false);
  }

  if (keepers.length === 0 && connectors.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="notes-banner"
      className="flex flex-wrap items-center gap-3 border-b border-amber-700/50 bg-amber-950/60 px-4 py-2 text-sm text-amber-100"
    >
      <span data-testid="notes-banner-text">{notesBannerText(keepers.map(ownedName), connectors.map(ownedName))}</span>
      {optedOut ? (
        <span className="flex items-center gap-2">
          <span data-testid="notes-opted-out">You&apos;re left out: your words aren&apos;t kept in notes, passed to assistant apps, or transcribed for them.</span>
          <button type="button" className="underline" disabled={pending} onClick={() => setOptOut(false)}>
            Include me
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="rounded bg-amber-700 px-2 py-0.5 font-medium text-white hover:bg-amber-600"
          disabled={pending}
          onClick={() => setOptOut(true)}
        >
          Leave me out
        </button>
      )}
      {error && (
        <span role="alert" className="text-red-300">
          {error}
        </span>
      )}
    </div>
  );
}
