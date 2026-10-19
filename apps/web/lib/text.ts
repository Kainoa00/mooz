/**
 * Meeting text as models see it, with the bridge's exact rules (mooz_agent/transcript.py),
 * so both doors give assistants the same escaped, one-line-per-message view.
 */

// Everything that could start a new line for a model's tokenizer.
const LINE_BREAKS = /\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]/g;
// Invisible and direction-changing characters (also refused in display names).
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** One visible line; with `markup`, angle brackets are escaped so text can't close a block. */
export function flatten(text: string, { markup = true }: { markup?: boolean } = {}): string {
  const flat = text.replace(INVISIBLE, "").replace(LINE_BREAKS, "\\n");
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
