"use client";

import { useState, type FormEvent } from "react";
import { errorMessage, readBody } from "@/lib/fetch-json";

export interface JoinResult {
  token: string;
  url: string;
  identity: string;
  isHost: boolean;
  name: string;
}

/** Why the last call ended when the person didn't leave: it couldn't connect, or it dropped. */
export function CallFailed() {
  return (
    <div role="alert" className="flex flex-col gap-1 text-sm">
      <p className="text-red-600">The call couldn&apos;t connect.</p>
      <p className="text-muted">
        The meeting&apos;s call server couldn&apos;t be reached. If you opened mooz through a tunnel or at an address
        other than the server&apos;s own, open it at the server&apos;s address instead (on a laptop setup,
        http://localhost:3000).
      </p>
    </div>
  );
}

export function JoinForm({
  slug,
  callFailed = false,
  onJoined,
}: {
  slug: string;
  /** The last call couldn't connect (or dropped): say so until they try again. */
  callFailed?: boolean;
  onJoined: (r: JoinResult) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(callFailed);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFailed(false);
    const marker = `mooz_joined_${slug}`;
    let rejoin: string | null = null;
    try {
      rejoin = sessionStorage.getItem(marker); // this tab's identity from an earlier join
    } catch {
      // storage unavailable (private mode): join as new
    }
    const res = await fetch(`/api/rooms/${slug}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, rejoin }),
    }).catch(() => null);
    const body = res ? await readBody(res) : null;
    if (!res?.ok || !body) {
      setError(errorMessage(body, "Could not join. Check your connection and try again."));
      setBusy(false);
      return;
    }
    try {
      sessionStorage.setItem(marker, String(body.identity));
    } catch {
      // ignore
    }
    onJoined({ ...(body as unknown as Omit<JoinResult, "name">), name: name.trim() });
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Join meeting</h1>
      <p className="font-mono text-sm text-muted">{slug}</p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Your name
          <input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            required
            autoFocus
            className="rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-base dark:border-zinc-700"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-60"
        >
          {busy ? "Joining…" : "Join"}
        </button>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {failed && <CallFailed />}
      </form>
    </main>
  );
}
