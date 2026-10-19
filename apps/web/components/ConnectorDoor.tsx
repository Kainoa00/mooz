"use client";

import { useEffect, useState } from "react";
import { APP_LABEL, setupSteps, type AssistantApp } from "@/lib/connector-protocol";
import { errorMessage, readBody } from "@/lib/fetch-json";
import type { BroughtConnector } from "./ConnectorAgent";
import { VoiceSettingsForm } from "./ConnectorVoice";

interface ConnectorInfo {
  id: string;
  name: string;
  app: AssistantApp;
  lastUsedAt?: number | null;
}

/** When the link was last used, so an owner can spot one that leaked. */
function lastUsed(at: number | null | undefined): string {
  if (!at) return "not used yet";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "used just now";
  if (minutes < 60) return `used ${minutes} min ago`;
  return `last used ${new Date(at).toLocaleString()}`;
}

const APPS: AssistantApp[] = ["grok", "claude", "chatgpt", "other"];

async function fetchConnectors(): Promise<ConnectorInfo[]> {
  const res = await fetch("/api/connectors", { cache: "no-store" }).catch(() => null);
  const body = res ? await readBody(res) : null;
  return ((body?.connectors as ConnectorInfo[] | undefined) ?? []).slice();
}

/**
 * The connector door: set up a private MCP link once in Grok, Claude or ChatGPT, then
 * bring that assistant into any meeting here. The link is shown only when it's made.
 */
export function ConnectorDoor({ slug, onBring }: { slug: string; onBring: (c: BroughtConnector) => void }) {
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [name, setName] = useState("");
  const [app, setApp] = useState<AssistantApp>("grok");
  const [shown, setShown] = useState<{ connector: ConnectorInfo; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchConnectors().then((list) => {
      if (live) setConnectors(list);
    });
    return () => {
      live = false;
    };
  }, []);

  async function load() {
    setConnectors(await fetchConnectors());
  }

  async function call(url: string, init: RequestInit, fallback: string): Promise<Record<string, unknown> | null> {
    setError(null);
    const res = await fetch(url, init).catch(() => null);
    const body = res ? await readBody(res) : null;
    if (!res?.ok) {
      setError(errorMessage(body, fallback));
      return null;
    }
    return body;
  }

  async function create() {
    const body = await call(
      "/api/connectors",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, app, slug }) },
      "Could not create the connector.",
    );
    if (!body) return;
    setShown(body as unknown as { connector: ConnectorInfo; url: string });
    setCopied(false);
    setName("");
    await load();
  }

  async function rotate(c: ConnectorInfo) {
    const body = await call(`/api/connectors/${c.id}/rotate`, { method: "POST" }, "Could not make a new link.");
    if (body) {
      setShown(body as unknown as { connector: ConnectorInfo; url: string });
      setCopied(false);
    }
  }

  async function remove(c: ConnectorInfo) {
    if (await call(`/api/connectors/${c.id}`, { method: "DELETE" }, "Could not delete the connector.")) {
      if (shown?.connector.id === c.id) setShown(null);
      await load();
    }
  }

  async function bring(c: ConnectorInfo) {
    const body = await call(
      `/api/rooms/${slug}/connector-requests`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectorId: c.id }) },
      `Could not bring ${c.name} in.`,
    );
    if (body) onBring({ requestId: String(body.requestId), name: c.name, app: c.app });
  }

  async function copy() {
    if (!shown) return;
    await navigator.clipboard?.writeText(shown.url).catch(() => undefined);
    setCopied(true);
  }

  return (
    <div data-testid="connector-door" className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Bring the Grok, Claude or ChatGPT you already use, with its memory. It joins as your agent; when someone
        asks it something, you get a one-tap link to send the question to it.
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {shown && (
        <div className="flex flex-col gap-2 rounded-lg bg-surface p-3 text-sm">
          <p className="font-medium">Add {shown.connector.name} to {APP_LABEL[shown.connector.app]}:</p>
          <ol className="list-decimal pl-5">
            {setupSteps(shown.connector.app).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <code data-testid="connector-url" className="block break-all rounded bg-background p-2 font-mono text-xs">
            {shown.url}
          </code>
          <p className="text-xs text-muted">
            Anyone with this link can read what you share with your agent in a meeting, so keep it private. It&apos;s
            shown only now; you can make a new one any time. Use it today: a link that&apos;s never used in a
            meeting is deleted after a day (and any link, after half a year without use).
          </p>
          <button type="button" onClick={copy} className="self-start rounded-lg border border-zinc-400 px-3 py-1">
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
      {connectors && connectors.length > 0 && (
        <ul className="flex flex-col gap-2">
          {connectors.map((c) => (
            <li key={c.id} data-testid="connector-row" className="flex flex-wrap items-center gap-2 text-sm">
              <span className="flex-1">
                🤖 <strong>{c.name}</strong> <span className="text-muted">({APP_LABEL[c.app]}, {lastUsed(c.lastUsedAt)})</span>
              </span>
              <button type="button" data-testid="connector-bring" onClick={() => bring(c)} className="rounded-lg bg-agent px-3 py-1 text-white">
                Bring to this meeting
              </button>
              <button type="button" onClick={() => rotate(c)} className="rounded-lg border border-zinc-400 px-2 py-1">
                New link
              </button>
              <button type="button" onClick={() => remove(c)} className="rounded-lg border border-zinc-400 px-2 py-1">
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <VoiceSettingsForm />
      <form
        className="flex flex-wrap items-end gap-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="flex flex-col gap-1">
          Its name in meetings
          <input
            data-testid="connector-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Grok"
            className="w-36 rounded-lg border border-zinc-500 bg-transparent px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          App
          <select
            data-testid="connector-app"
            value={app}
            onChange={(e) => setApp(e.target.value as AssistantApp)}
            className="rounded-lg border border-zinc-500 bg-transparent px-2 py-1"
          >
            {APPS.map((a) => (
              <option key={a} value={a}>
                {a === "other" ? "Other" : APP_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" data-testid="connector-create" disabled={!name.trim()} className="rounded-lg bg-accent px-3 py-1 text-white">
          Create a connector
        </button>
      </form>
    </div>
  );
}
