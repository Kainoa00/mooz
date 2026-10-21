"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage, readBody } from "@/lib/fetch-json";

export function NewMeetingButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/rooms", { method: "POST" }).catch(() => null);
    const body = res ? await readBody(res) : null;
    if (!res?.ok || typeof body?.slug !== "string") {
      // The server says why (lots of meetings starting at once, say).
      setError(errorMessage(body, "Could not create a meeting"));
      setBusy(false);
      return;
    }
    router.push(`/r/${body.slug}`);
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="self-start rounded-lg bg-accent px-5 py-3 font-medium text-white disabled:opacity-60"
      >
        {busy ? "Creating…" : "Start a meeting"}
      </button>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
