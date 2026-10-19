/**
 * What the browser and agents say to each other about meeting notes (safe to use in the client).
 *
 * - The host's policy is LiveKit room metadata: `{"notes_allowed": true}`. Only the server sets it.
 * - Each person's opt-out is the participant attribute `notes_opt_out` = "1". Only the server sets it.
 * - An agent announces it is keeping notes on the `mooz.v0` data topic:
 *   `{"type": "notes", "state": "on" | "off"}`. LiveKit stamps the sender, so an announcement
 *   only ever speaks for the agent that sent it.
 * - A browser that (re)connects asks with `{"type": "notes?"}`; each agent answers it directly.
 */

export const MOOZ_TOPIC = "mooz.v0";
export const NOTES_OPT_OUT_ATTRIBUTE = "notes_opt_out";

/** Ask every agent whether it is keeping notes (after joining or reconnecting). */
export const NOTES_QUERY: Uint8Array<ArrayBuffer> = new TextEncoder().encode(JSON.stringify({ type: "notes?" }));

export function notesAllowed(metadata: string | undefined): boolean {
  if (!metadata) return false;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).notes_allowed === true;
  } catch {
    return false;
  }
}

export function parseNotesAnnouncement(payload: Uint8Array): "on" | "off" | null {
  try {
    const msg: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return null;
    const { type, state } = msg as Record<string, unknown>;
    return type === "notes" && (state === "on" || state === "off") ? state : null;
  } catch {
    return null;
  }
}

function list(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The banner for agents that keep notes and connector agents, which pass the last few
 * minutes of the meeting to their owner's assistant app (where its chat history keeps them).
 */
export function notesBannerText(keepers: string[], connectors: string[] = []): string {
  const parts: string[] = [];
  if (keepers.length) parts.push(`${list(keepers)} ${keepers.length === 1 ? "is" : "are"} keeping notes`);
  if (connectors.length) {
    const one = connectors.length === 1;
    parts.push(
      `${list(connectors)} can pass what's said to ${one ? "its owner's" : "their owners'"} assistant app${one ? "" : "s"} when asked` +
        ` (and with voice on, ${one ? "its owner's ElevenLabs account transcribes" : "their owners' ElevenLabs accounts transcribe"} it)`,
    );
  }
  return `📝 ${parts.join("; ")}`;
}
