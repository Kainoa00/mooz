/**
 * Meeting text as models see it: one line per message, nothing hidden, nothing that can
 * close a block. Lookalike characters are normalized (so a fullwidth "＜/meeting＞" is escaped
 * too), and a typed line break shows as " ⏎ ", so what follows it can't pass for a new message
 * with its own role tag. The bridge (mooz_agent/transcript.py) applies the same rules; both run
 * bridge/tests/text_cases.json.
 */

// Everything that could start a new line for a model's tokenizer.
const LINE_BREAKS = /\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]/g;
// Anything that shows as nothing and can carry hidden text to a model: format characters
// (bidi controls, Unicode tags, soft hyphens…), private-use code points, lone surrogates and
// the variation selectors that can smuggle bytes after an emoji. What emoji need stays, once:
// a joiner (Persian and Indic text use them too) or a presentation selector (❤️), and the tag
// letters of the three standard subdivision flags (England, Scotland, Wales: 🏴󠁧󠁢󠁳󠁣󠁴󠁿). A run of joiners and selectors keeps at most one selector
// then one joiner (the pair in 🏳️‍🌈), so it can't spell anything either.
const HIDDEN =
  /(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})|([\u200C\u200D\uFE0E\uFE0F]+)|[\p{Cf}\p{Co}\p{Cs}\u{FE00}-\u{FE0D}\u{E0100}-\u{E01EF}]/gu;
const SELECTOR = /[\uFE0E\uFE0F]/;
const JOINER = /[\u200C\u200D]/;
const shrink = (run: string) => (run.match(SELECTOR)?.[0] ?? "") + (run.match(JOINER)?.[0] ?? "");
const clean = (text: string) =>
  text.replace(HIDDEN, (_all, flag?: string, run?: string) => flag ?? (run ? shrink(run) : ""));

/** Whether text has anything `flatten` would remove as hidden (display names refuse those). */
export function hasHidden(text: string): boolean {
  return clean(text) !== text;
}

/** One visible line; with `markup`, angle brackets are escaped so text can't close a block. */
export const BREAK = " ⏎ ";

export function flatten(text: string, { markup = true }: { markup?: boolean } = {}): string {
  const flat = clean(clean(text).normalize("NFKC")).replace(LINE_BREAKS, BREAK);
  return markup ? flat.replaceAll("<", "&lt;").replaceAll(">", "&gt;") : flat;
}

/** Text shown or spoken as-is (an answer): keeps its lines, loses hidden characters. */
export function stripInvisible(text: string): string {
  return clean(text);
}

export interface RenderableLine {
  role: string;
  name: string;
  kind: "human" | "agent";
  via: "voice" | "chat";
  text: string;
}

/** `[guest] Zach (chat): …`: the bracketed role comes from the server, never from a name. */
export function renderLine(line: RenderableLine): string {
  const name = flatten(line.name).replaceAll("[", "").replaceAll("]", "").trim();
  const via = line.via === "chat" && line.kind === "human" ? " (chat)" : "";
  return `[${line.role}] ${name}${via}: ${flatten(line.text)}`;
}
