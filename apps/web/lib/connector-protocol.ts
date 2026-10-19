/**
 * Connector agents, as the owner's browser tab sees them (safe to use in the client).
 *
 * The server sends the agent its assistant's answers as LiveKit data packets on topic
 * `mooz.connector`, addressed to the agent's identity. Only the server sends these: a
 * packet from any participant is ignored.
 */

export const CONNECTOR_TOPIC = "mooz.connector";

export type AssistantApp = "grok" | "claude" | "chatgpt" | "other";

export const APP_LABEL: Record<AssistantApp, string> = {
  grok: "Grok",
  claude: "Claude",
  chatgpt: "ChatGPT",
  other: "your assistant",
};

export interface AnswerPacket {
  type: "answer";
  id: string;
  spoken: string;
  details: string;
  reply_to: string;
  sources: string[];
}

const MAX_SPOKEN = 400;
const MAX_DETAILS = 4000;
// Above what the server can name (lib/connector-queue.ts MAX_ENTRY_PEOPLE): never cut short,
// since anyone dropped from `sources` couldn't take the answer out of notes by opting out.
const MAX_SOURCES = 200;

/** An answer packet from the server, validated and capped (null if it isn't one). */
export function parseAnswerPacket(payload: Uint8Array): AnswerPacket | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== "answer" || typeof m.id !== "string" || m.id.length > 40) return null;
  if (typeof m.spoken !== "string" || !m.spoken.trim() || typeof m.reply_to !== "string") return null;
  if (m.details !== undefined && typeof m.details !== "string") return null;
  if (!Array.isArray(m.sources) || !m.sources.every((s) => typeof s === "string")) return null;
  return {
    type: "answer",
    id: m.id,
    spoken: m.spoken.slice(0, MAX_SPOKEN),
    details: (m.details ?? "").slice(0, MAX_DETAILS),
    reply_to: m.reply_to.slice(0, 100),
    sources: (m.sources as string[]).slice(0, MAX_SOURCES),
  };
}

/** What the owner sends their assistant: short, and none of the meeting's words. */
export function assistantPrompt(questionId: string): string {
  return (
    `Answer question ${questionId} from my mooz meeting: use the mooz connector's get_question tool, ` +
    "then post_answer with your answer."
  );
}

const PREFILL: Partial<Record<AssistantApp, string>> = {
  grok: "https://grok.com/?q=",
  claude: "https://claude.ai/new?q=",
  chatgpt: "https://chatgpt.com/?q=",
};

/** A link that opens the app with the prompt filled in (undocumented; Copy always works too). */
export function assistantLink(app: AssistantApp, prompt: string): string | null {
  const base = PREFILL[app];
  return base ? `${base}${encodeURIComponent(prompt)}` : null;
}

/** How to add the connector link in each app. */
export function setupSteps(app: AssistantApp): string[] {
  switch (app) {
    case "grok":
      return [
        "Open grok.com/connectors and choose New Connector, then Custom.",
        "Paste the link below as the server URL and save.",
      ];
    case "claude":
      return [
        "In Claude, open Settings, then Connectors, and choose Add custom connector.",
        "Name it mooz, paste the link below as the URL, and add it.",
      ];
    case "chatgpt":
      return [
        "In ChatGPT, open Settings, then Apps & Connectors, then Advanced, and turn on Developer mode.",
        "Create a connector, paste the link below as its URL, and choose no authentication.",
        "If your plan can't use write actions, paste the answer back here instead.",
      ];
    default:
      return [
        "Add a custom MCP connector (Streamable HTTP) in your assistant app.",
        "Paste the link below as its URL, with no authentication.",
      ];
  }
}

/** How much of an answer is read aloud (the server's cap for `spoken`). */
export const SPOKEN_LIMIT = 400;

/**
 * An answer the owner pasted from their app: its first sentences (up to three, within the
 * spoken limit) are read aloud, and everything after them is posted in chat as details.
 */
export function splitPastedAnswer(text: string): { spoken: string; details?: string } {
  const all = text.trim();
  if (all.length <= SPOKEN_LIMIT) return { spoken: all };
  // Sentence ends, by position in the original, so what's left keeps its own layout.
  const ends = [...all.matchAll(/[.!?](?=\s)|\n/g)].map((m) => m.index + 1);
  let cut = 0;
  for (const end of ends.slice(0, 3)) {
    if (all.slice(0, end).trim().length > SPOKEN_LIMIT) break;
    cut = end;
  }
  if (!cut) {
    // One very long sentence: say its start, and post it all.
    const head = all.slice(0, SPOKEN_LIMIT - 1);
    return { spoken: `${head.slice(0, Math.max(head.lastIndexOf(" "), SPOKEN_LIMIT / 2)).trimEnd()}…`, details: all };
  }
  return { spoken: all.slice(0, cut).replace(/\s+/g, " ").trim(), details: all.slice(cut).trim() };
}
