/**
 * The meeting's chat as a tab holds it. Each line keeps the identity LiveKit says sent it, and
 * shows only once the tab knows who that is. LiveKit tells the room about someone who
 * publishes nothing (a chat-only agent) in a batch every few seconds, while their chat goes
 * out at once, so their first words can arrive before they do. Shown then, an agent's words
 * would be a "Guest"'s, for good.
 */

/** Chat: text streams on this topic (see docs/protocol.md). */
export const CHAT_TOPIC = "lk.chat";
/** LiveKit's older chat, as data packets (lib/chat-decode.ts). */
export const LEGACY_CHAT_TOPIC = "lk-chat-topic";

export interface ChatLine<P> {
  id: string;
  /** Who LiveKit says sent it (the server sets it: nobody can send as someone else). */
  identity: string;
  message: string;
  timestamp: number;
  attributes?: Readonly<Record<string, string>>;
  /** The sender, once the tab knows them. */
  from?: P;
}

/** A line the chat shows: its sender is known. */
export type ShownLine<P> = ChatLine<P> & { from: P };

type Find<P> = (identity: string) => P | undefined;

/** Adds a line, with its sender if the tab knows them. The same message again replaces it, in place. */
export function addLine<P>(lines: readonly ChatLine<P>[], line: ChatLine<P>, find: Find<P>): readonly ChatLine<P>[] {
  if (!line.identity) return lines; // no participant sent it: it can never be anyone's
  const next = { ...line, from: line.from ?? find(line.identity) };
  // The same id from someone else is another line: an id is the sender's to choose.
  const at = lines.findIndex((l) => l.identity === line.identity && l.id === line.id);
  return at < 0 ? [...lines, next] : lines.map((l, i) => (i === at ? next : l));
}

/** Fills in the senders the tab has come to know since. The same array if there are none. */
export function resolveSenders<P>(lines: readonly ChatLine<P>[], find: Find<P>): readonly ChatLine<P>[] {
  let changed = false;
  const next = lines.map((l) => {
    const from = l.from ?? find(l.identity);
    if (from === l.from) return l;
    changed = true;
    return { ...l, from };
  });
  return changed ? next : lines;
}

/** What the chat shows, in the order it came: only lines whose sender the tab knows. */
export function shownLines<P>(lines: readonly ChatLine<P>[]): ShownLine<P>[] {
  return lines.filter((l): l is ShownLine<P> => l.from !== undefined);
}
