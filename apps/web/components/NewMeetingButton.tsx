"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewMeetingButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (!res.ok) throw new Error("Could not create a meeting");
      const { slug } = (await res.json()) as { slug: string };
      router.push(`/r/${slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a meeting");
      setBusy(false);
    }
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
