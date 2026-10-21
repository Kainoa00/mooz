"use client";

import { useCallback, useEffect, useState } from "react";
import type { MyAgentRequest } from "@/lib/agents";
import { errorMessage, readBody } from "@/lib/fetch-json";

const POLL_MS = 3000;

/**
 * The agents brought with my codes, checked every few seconds while it matters: while
 * `watching` (a code is out), and while any is waiting for the host. Polling stops otherwise.
 */
export function useMyAgentRequests(slug: string, watching: boolean) {
  const [requests, setRequests] = useState<MyAgentRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pending = requests.some((r) => r.status === "pending");

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/rooms/${slug}/my-agent-requests`, { cache: "no-store" }).catch(() => null);
    const body = res?.ok ? await readBody(res) : null;
    if (body && Array.isArray(body.requests)) setRequests(body.requests as MyAgentRequest[]);
  }, [slug]);

  useEffect(() => {
    if (!watching && !pending) return;
    // Right away, then every few seconds (and from a timer, never in the effect body itself).
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [watching, pending, refresh]);

  const cancel = useCallback(
    async (id: string) => {
      setError(null);
      const res = await fetch(`/api/rooms/${slug}/my-agent-requests/${encodeURIComponent(id)}/withdraw`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => null);
      if (!res?.ok) setError(errorMessage(res ? await readBody(res) : null, "Couldn't cancel it. Try again."));
      await refresh();
    },
    [slug, refresh],
  );

  return { requests, pending, error, cancel };
}

/** "Atlas is waiting for the host. Not yours? Cancel it." for each agent brought with my codes. */
export function MyAgentRequestList({
  requests,
  error,
  cancel,
  only,
}: {
  requests: MyAgentRequest[];
  error: string | null;
  cancel: (id: string) => void;
  only?: MyAgentRequest["status"];
}) {
  const shown = only ? requests.filter((r) => r.status === only) : requests;
  if (shown.length === 0 && !error) return null;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="my-agent-requests">
      {shown.map((r) => (
        <p key={r.id} data-testid="my-agent-request" data-status={r.status} className="flex flex-wrap items-center gap-2">
          <span>
            <strong>{r.agentName}</strong> {r.status === "pending" ? "is waiting for the host." : "is in the meeting as your agent."}{" "}
            Not yours?
          </span>
          <button type="button" onClick={() => cancel(r.id)} className="rounded-lg border border-zinc-400 px-2 py-0.5">
            {r.status === "pending" ? "Cancel it" : "Remove it"}
          </button>
        </p>
      ))}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
