"use client";

import { useRoomInfo } from "@livekit/components-react";
import { useState } from "react";
import { errorMessage, readBody } from "@/lib/fetch-json";
import { notesAllowed } from "@/lib/notes-protocol";

/** Host-only: let agents keep meeting notes here. Off by default; LiveKit tells everyone. */
export function NotesPolicyToggle({ slug }: { slug: string }) {
  const { metadata } = useRoomInfo();
  const allowed = notesAllowed(metadata);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setPending(true);
    setError(null);
    const res = await fetch(`/api/rooms/${slug}/notes-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed: !allowed }),
    }).catch(() => null);
    if (!res?.ok) setError(errorMessage(res ? await readBody(res) : null, "That didn't go through. Try again."));
    setPending(false);
  }

  return (
    <label className="flex cursor-pointer items-center gap-1.5" title="Agents still need their owner to ask, and anyone can opt out">
      <input
        type="checkbox"
        data-testid="notes-policy"
        checked={allowed}
        disabled={pending}
        onChange={toggle}
        className="accent-emerald-500"
      />
      Allow agent notes
      {error && (
        <span role="alert" className="text-red-400">
          {error}
        </span>
      )}
    </label>
  );
}
