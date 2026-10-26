/** A chat message as LiveKit's older clients send it, in a data packet. */
export interface LegacyChat {
  id: string;
  message: string;
  timestamp: number;
  attributes?: Record<string, string>;
}

/**
 * Chat that arrives on LiveKit's old data-packet topic (mooz itself sends chat as text streams).
 * Anyone in the meeting can publish one, so anything but a well-formed message is ignored (null):
 * a bad one would otherwise crash every tab (an object for an id or text) or end chat for good
 * (not JSON at all).
 */
export function decodeLegacyChat(data: Uint8Array): LegacyChat | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  // ignoreLegacy: the echo of a message also sent as a text stream.
  if (m.ignoreLegacy === true || typeof m.id !== "string" || typeof m.message !== "string") return null;
  if (typeof m.timestamp !== "number" || !Number.isFinite(m.timestamp)) return null;
  const attributes =
    typeof m.attributes === "object" && m.attributes !== null
      ? Object.fromEntries(Object.entries(m.attributes).filter((e): e is [string, string] => typeof e[1] === "string"))
      : undefined;
  return { id: m.id, message: m.message, timestamp: m.timestamp, ...(attributes ? { attributes } : {}) };
}
