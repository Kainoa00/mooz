"use client";

import { useDataChannel, useLocalParticipant, useParticipantAttributes, useParticipants } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { useCallback, useState } from "react";
import { errorMessage, readBody } from "@/lib/fetch-json";
import { isAgent, ownedName } from "@/lib/labels";
import { MOOZ_TOPIC, NOTES_OPT_OUT_ATTRIBUTE, notesBannerText, parseNotesAnnouncement } from "@/lib/notes-protocol";

/**
 * Shown to everyone while any agent says it is keeping notes, with a way to be left out.
 * Announcements count only from agents, and only for themselves (LiveKit stamps the sender).
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

  // An agent that left is no longer keeping notes, whatever it last said.
  const agents = useParticipants().filter((p) => isAgent(p) && keeping.has(p.identity));
  const { localParticipant } = useLocalParticipant();
  const { attributes } = useParticipantAttributes({ participant: localParticipant });
  const optedOut = attributes?.[NOTES_OPT_OUT_ATTRIBUTE] === "1";

  async function setOptOut(optOut: boolean) {
    setPending(true);
    setError(null);
    const res = await fetch(`/api/rooms/${slug}/notes-opt-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optOut }),
    }).catch(() => null);
    if (!res?.ok) setError(errorMessage(res ? await readBody(res) : null, "That didn't go through. Try again."));
    setPending(false);
  }

  if (agents.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="notes-banner"
      className="flex flex-wrap items-center gap-3 border-b border-amber-700/50 bg-amber-950/60 px-4 py-2 text-sm text-amber-100"
    >
      <span data-testid="notes-banner-text">{notesBannerText(agents.map(ownedName))}</span>
      {optedOut ? (
        <span className="flex items-center gap-2">
          <span data-testid="notes-opted-out">You&apos;re left out: your words aren&apos;t in the notes.</span>
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
