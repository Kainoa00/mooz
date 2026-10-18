/**
 * What the browser and agents say to each other about meeting notes (safe to use in the client).
 *
 * - The host's policy is LiveKit room metadata: `{"notes_allowed": true}`. Only the server sets it.
 * - Each person's opt-out is the participant attribute `notes_opt_out` = "1". Only the server sets it.
 * - An agent announces it is keeping notes on the `mooz.v0` data topic:
 *   `{"type": "notes", "state": "on" | "off"}`. LiveKit stamps the sender, so an announcement
 *   only ever speaks for the agent that sent it.
 */

export const MOOZ_TOPIC = "mooz.v0";
export const NOTES_OPT_OUT_ATTRIBUTE = "notes_opt_out";

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

export function notesBannerText(agentNames: string[]): string {
  const names =
    agentNames.length <= 1
      ? agentNames.join("")
      : `${agentNames.slice(0, -1).join(", ")} and ${agentNames[agentNames.length - 1]}`;
  return `📝 ${names} ${agentNames.length === 1 ? "is" : "are"} keeping notes`;
}
