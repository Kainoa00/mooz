import type { useChat } from "@livekit/components-react";

type Decoder = NonNullable<NonNullable<Parameters<typeof useChat>[0]>["messageDecoder"]>;
type Decoded = ReturnType<Decoder>;

const IGNORE = { ignoreLegacy: true } as unknown as Decoded;

/**
 * Chat that arrives on LiveKit's old data-packet topic (mooz itself sends chat as text streams).
 * Anyone in the meeting can publish one, so anything but a well-formed message is ignored: a bad
 * one would otherwise crash every tab (an object for an id or text) or end chat for good (not
 * JSON at all).
 */
export const decodeLegacyChat: Decoder = (data) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return IGNORE;
  }
  if (typeof parsed !== "object" || parsed === null) return IGNORE;
  const m = parsed as Record<string, unknown>;
  if (m.ignoreLegacy === true || typeof m.id !== "string" || typeof m.message !== "string") return IGNORE;
  if (typeof m.timestamp !== "number" || !Number.isFinite(m.timestamp)) return IGNORE;
  const attributes =
    typeof m.attributes === "object" && m.attributes !== null
      ? Object.fromEntries(Object.entries(m.attributes).filter(([, v]) => typeof v === "string"))
      : undefined;
  return { id: m.id, message: m.message, timestamp: m.timestamp, ...(attributes ? { attributes } : {}) } as Decoded;
};
