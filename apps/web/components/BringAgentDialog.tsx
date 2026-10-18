"use client";

import { useState } from "react";
import { errorMessage, readBody } from "@/lib/fetch-json";

interface AgentCode {
  code: string;
  command: string;
  expiresAt: number;
}

/** Shows the one-time command that connects the user's own agent to this meeting. */
export function BringAgentDialog({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<AgentCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
    setCode(body as unknown as AgentCode);
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
      {open && (
        <div role="dialog" aria-label="Bring my agent" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl bg-background p-5 text-foreground shadow-xl">
            <h2 className="text-lg font-semibold">Bring your agent into this meeting</h2>
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
            <button type="button" onClick={() => setOpen(false)} className="self-end rounded-lg bg-accent px-4 py-2 text-sm text-white">
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
}
