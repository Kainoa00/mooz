/**
 * Meeting text as models see it: one line per message, nothing hidden, nothing that can
 * close a block. Like the bridge's rules (mooz_agent/transcript.py), plus two more for text
 * that leaves for someone else's assistant app: lookalike characters are normalized (so a
 * fullwidth "＜/meeting＞" is escaped too), and a typed line break shows as " ⏎ ", so what
 * follows it can't pass for a new message with its own role tag.
 */

// Everything that could start a new line for a model's tokenizer.
const LINE_BREAKS = /\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]/g;
// Invisible and direction-changing characters (also refused in display names).
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** One visible line; with `markup`, angle brackets are escaped so text can't close a block. */
export const BREAK = " ⏎ ";

export function flatten(text: string, { markup = true }: { markup?: boolean } = {}): string {
  const flat = text.replace(INVISIBLE, "").normalize("NFKC").replace(INVISIBLE, "").replace(LINE_BREAKS, BREAK);
  return markup ? flat.replaceAll("<", "&lt;").replaceAll(">", "&gt;") : flat;
}

/** Text shown or spoken as-is (an answer): keeps its lines, loses hidden characters. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
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
