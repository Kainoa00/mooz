"use client";

import { useEffect, useState } from "react";
import { errorMessage, readBody } from "@/lib/fetch-json";
import type { BroughtConnector } from "./ConnectorAgent";
import { ConnectorDoor } from "./ConnectorDoor";
import { MyAgentRequestList, useMyAgentRequests } from "./MyAgentRequests";

interface AgentCode {
  code: string;
  command: string;
  expiresAt: number;
}

/**
 * Two doors for the user's own agent: the assistant app they already use (a connector),
 * or the one-time command that connects mooz-agent on their machine. While a code is out,
 * it follows what was done with it, so a code someone else used can't pass unnoticed: the
 * owner sees "Atlas is waiting for the host" here, or in a small tray, and can cancel it.
 */
export function BringAgentDialog({
  slug,
  onBringConnector,
}: {
  slug: string;
  onBringConnector?: (connector: BroughtConnector) => void;
}) {
  const [open, setOpen] = useState(false);
  const [door, setDoor] = useState<"connector" | "bridge">("bridge");
  const [code, setCode] = useState<AgentCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Until the last code shown expires.
  const [watchUntil, setWatchUntil] = useState<number | null>(null);
  const mine = useMyAgentRequests(slug, open || watchUntil !== null);

  useEffect(() => {
    if (watchUntil === null) return;
    const timer = setTimeout(() => setWatchUntil(null), Math.max(0, watchUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [watchUntil]);

  async function openDialog() {
    setOpen(true);
    setError(null);
    setCopied(false);
    setCode(null);
    const res = await fetch(`/api/rooms/${slug}/agent-codes`, { method: "POST" }).catch(() => null);
    const body = res ? await readBody(res) : null;
    if (!res?.ok || !body) {
      setError(errorMessage(body, "Could not create a code. Try again."));
      return;
    }
    const made = body as unknown as AgentCode;
    setCode(made);
    setWatchUntil(made.expiresAt);
  }

  async function copy() {
    if (!code) return;
    await navigator.clipboard?.writeText(`${code.command} --name `).catch(() => undefined);
    setCopied(true);
  }

  return (
    <>
      <button type="button" onClick={openDialog} className="rounded-lg bg-agent px-3 py-1.5 text-sm font-medium text-white">
        Bring my agent
      </button>
      {!open && mine.pending && (
        <div className="fixed bottom-20 left-4 z-40 max-w-sm rounded-lg bg-surface p-3 text-foreground shadow-lg">
          <MyAgentRequestList requests={mine.requests} error={mine.error} cancel={(id) => void mine.cancel(id)} only="pending" />
        </div>
      )}
      {open && (
        <div role="dialog" aria-label="Bring my agent" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-full w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-xl bg-background p-5 text-foreground shadow-xl">
            <h2 className="text-lg font-semibold">Bring your agent into this meeting</h2>
            <div role="tablist" className="flex gap-2 text-sm">
              <button
                type="button"
                role="tab"
                aria-selected={door === "connector"}
                onClick={() => setDoor("connector")}
                className={`rounded-lg px-3 py-1 ${door === "connector" ? "bg-agent text-white" : "border border-zinc-400"}`}
              >
                Grok, Claude or ChatGPT
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={door === "bridge"}
                onClick={() => setDoor("bridge")}
                className={`rounded-lg px-3 py-1 ${door === "bridge" ? "bg-agent text-white" : "border border-zinc-400"}`}
              >
                mooz-agent on my machine
              </button>
            </div>
            {door === "connector" && onBringConnector && (
              <ConnectorDoor
                slug={slug}
                onBring={(c) => {
                  onBringConnector(c);
                  setOpen(false);
                }}
              />
            )}
            {door === "bridge" && (
            <>
            <p className="text-sm text-muted">
              Run this on the machine where your agent lives. Your API keys stay on that machine. The
              host approves your agent before it can hear anything. The code works once and expires in
              10 minutes.
            </p>
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
            {code && (
              <div className="flex flex-col gap-2">
                <code data-testid="agent-command" className="block break-all rounded-lg bg-surface p-3 font-mono text-sm">
                  {code.command} --name &lt;AgentName&gt;
                </code>
                <span className="sr-only" data-testid="agent-code">{code.code}</span>
                <button type="button" onClick={copy} className="self-start rounded-lg border border-zinc-400 px-3 py-1 text-sm">
                  {copied ? "Copied" : "Copy command"}
                </button>
              </div>
            )}
            <MyAgentRequestList requests={mine.requests} error={mine.error} cancel={(id) => void mine.cancel(id)} />
            </>
            )}
            <button type="button" onClick={() => setOpen(false)} className="self-end rounded-lg bg-accent px-4 py-2 text-sm text-white">
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
}
