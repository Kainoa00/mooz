"use client";

import { useCallback, useEffect, useState } from "react";

interface PendingRequest {
  id: string;
  agentName: string;
  ownerName: string;
}

const POLL_MS = 2000;

/** Host-only: agents waiting to join. Nothing can listen in until the host approves. */
export function AgentRequestsTray({ slug }: { slug: string }) {
  const [requests, setRequests] = useState<PendingRequest[]>([]);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/rooms/${slug}/agent-requests`, { cache: "no-store" });
    if (res.ok) setRequests(((await res.json()) as { requests: PendingRequest[] }).requests);
  }, [slug]);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  async function decide(id: string, decision: "approve" | "deny") {
    setRequests((rs) => rs.filter((r) => r.id !== id));
    await fetch(`/api/rooms/${slug}/agent-requests/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    await refresh();
  }

  if (requests.length === 0) return null;

  return (
    <aside aria-label="Agents waiting to join" className="fixed right-4 top-14 z-40 flex w-80 flex-col gap-2">
      {requests.map((r) => (
        <div key={r.id} data-testid="agent-request" className="flex flex-col gap-2 rounded-xl bg-surface p-3 text-sm shadow-lg">
          <span>
            🤖 <strong>{r.ownerName}&apos;s {r.agentName}</strong> wants to join. It will hear the meeting and
            can speak when addressed.
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={() => decide(r.id, "approve")} className="rounded-lg bg-agent px-3 py-1 text-white">
              Approve
            </button>
            <button type="button" onClick={() => decide(r.id, "deny")} className="rounded-lg border border-zinc-400 px-3 py-1">
              Deny
            </button>
          </div>
        </div>
      ))}
    </aside>
  );
}
