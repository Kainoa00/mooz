"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, readBody } from "@/lib/fetch-json";

interface PendingRequest {
  id: string;
  agentName: string;
  ownerName: string;
  door?: "bridge" | "connector";
}

const POLL_MS = 2000;

/** Host-only: agents waiting to join. Nothing can listen in until the host approves. */
export function AgentRequestsTray({ slug }: { slug: string }) {
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Requests the host just answered: hide them even if an in-flight poll still lists them.
  const decided = useRef(new Set<string>());
  const polling = useRef(false);

  const refresh = useCallback(async () => {
    if (polling.current) return; // never overlap polls
    polling.current = true;
    try {
      const res = await fetch(`/api/rooms/${slug}/agent-requests`, { cache: "no-store" });
      const body = await readBody(res);
      if (res.ok && body) {
        const list = (body.requests as PendingRequest[]) ?? [];
        setRequests(list.filter((r) => !decided.current.has(r.id)));
      }
    } catch {
      // Offline for a moment; the next poll will catch up.
    } finally {
      polling.current = false;
    }
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
    setError(null);
    decided.current.add(id);
    setRequests((rs) => rs.filter((r) => r.id !== id));
    const res = await fetch(`/api/rooms/${slug}/agent-requests/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }).catch(() => null);
    if (!res?.ok) {
      decided.current.delete(id); // let it reappear so the host can try again
      setError(errorMessage(res ? await readBody(res) : null, "That didn't go through. Try again."));
    }
    await refresh();
  }

  if (requests.length === 0 && !error) return null;

  return (
    <aside aria-label="Agents waiting to join" className="fixed right-4 top-14 z-40 flex w-80 flex-col gap-2">
      {error && (
        <p role="alert" className="rounded-xl bg-red-700 p-3 text-sm text-white">
          {error}
        </p>
      )}
      {requests.map((r) => (
        <div
          key={r.id}
          data-testid="agent-request"
          className="flex flex-col gap-2 rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm text-white shadow-lg"
        >
          <span>
            🤖 <strong>{r.ownerName}&apos;s {r.agentName}</strong> wants to join
            {r.door === "connector" ? " (their own assistant app, through a connector)" : ""}. It will hear the
            meeting and can speak when addressed.
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={() => decide(r.id, "approve")} className="rounded-lg bg-agent px-3 py-1 text-white">
              Approve
            </button>
            <button
              type="button"
              onClick={() => decide(r.id, "deny")}
              className="rounded-lg border border-zinc-500 px-3 py-1 text-zinc-200"
            >
              Deny
            </button>
          </div>
        </div>
      ))}
    </aside>
  );
}
