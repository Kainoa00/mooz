import { nameWords, sameWord, wakeWord } from "./addressing";
import { COMMON_WORDS } from "./common-words";
import { HttpError } from "./http";
import { hasHidden } from "./text";

const MAX_DISPLAY_NAME = 40;

// Control characters, and anything meeting text drops as hidden (bidi controls, invisible
// spacers, Unicode tags, smuggling selectors: see lib/text.ts), let a name render as
// something other than what a model reads. The robot marker is reserved for agents.
const DECEPTIVE = /\p{Cc}|🤖/u;

/**
 * Trim and validate a human display name. People cannot use the agent marker, invisible
 * characters, or a name with a word the detector would hear as an agent's wake word (saying
 * it to that person would wake the agent).
 */
export function parseDisplayName(value: unknown, agentNames: readonly string[] = []): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_name", "Name is required");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new HttpError(400, "invalid_name", "Name is required");
  if (name.length > MAX_DISPLAY_NAME) {
    throw new HttpError(400, "invalid_name", `Name must be at most ${MAX_DISPLAY_NAME} characters`);
  }
  if (DECEPTIVE.test(name) || hasHidden(name)) {
    throw new HttpError(400, "invalid_name", "Names cannot contain 🤖 or invisible characters");
  }
  const agent = agentNames.find((a) => heardAs(name, a));
  if (agent) {
    throw new HttpError(
      409,
      "name_taken",
      `"${name}" sounds like ${agent}, an agent in this meeting: saying it would wake the agent. Pick another name.`,
    );
  }
  return name;
}

/** Whether two words would be heard as each other, either way round. */
const alike = (a: string, b: string) => a === b || sameWord(a, b) || sameWord(b, a);

/** Whether saying any word of `name` would be heard as `agent`'s wake word. */
function heardAs(name: string, agent: string): boolean {
  const wake = wakeWord(agent);
  return wake !== undefined && nameWords(name).some((w) => alike(w, wake));
}

// An agent wakes up when its name is said, so names that people say all the
// time (or that address everyone) would trigger it constantly.
const RESERVED = new Set([
  "mooz", "agent", "agents", "everyone", "everybody", "all", "anyone", "somebody", "someone",
  "hey", "hi", "hello", "ok", "okay", "yes", "yeah", "no", "so", "well", "right", "sure",
  "you", "me", "we", "us", "they", "the", "and", "but", "bot", "ai", "assistant", "computer",
  "host", "guest", "chat", "meeting",
]);

const AGENT_NAME = /^[A-Za-z][A-Za-z0-9' -]{2,23}$/;

/**
 * Validate an agent's name: 3–24 characters, starting with a letter. Its wake word (the
 * name, or its last word: see lib/addressing.ts) must be at least 3 letters, not a reserved
 * or common word, and not something the detector would hear as any word of anyone's name in
 * the meeting ("Atlis" next to "Atlas", "Zack" next to "Kainoa Zach"). Nor may the name hold
 * a word that would wake an agent already here ("Grok Prime" next to "Grok").
 */
export function parseAgentName(value: unknown, people: readonly string[], agents: readonly string[] = []): string {
  const takenNames = [...people, ...agents];
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!AGENT_NAME.test(name)) {
    throw new HttpError(
      400,
      "invalid_agent_name",
      "Agent names are 2–24 characters: letters, numbers, spaces, apostrophes or dashes, starting with a letter",
    );
  }
  const key = name.toLowerCase();
  const wake = wakeWord(name) ?? "";
  if (RESERVED.has(key) || RESERVED.has(wake) || COMMON_WORDS.has(wake)) {
    throw new HttpError(400, "reserved_name", `"${name}" is too common to use as an agent's wake name`);
  }
  if (wake.length < 3) {
    throw new HttpError(400, "invalid_agent_name", "An agent's name needs a last word of at least 3 letters");
  }
  if (takenNames.some((taken) => taken.trim().toLowerCase() === key)) {
    throw new HttpError(409, "name_taken", `Someone in this meeting is already called "${name}"`);
  }
  const clash = takenNames.find((taken) => heardAs(taken, name)) ?? agents.find((agent) => heardAs(name, agent));
  if (clash) {
    throw new HttpError(
      409,
      "name_taken",
      `"${name}" sounds too much like "${clash}", who's already in this meeting: the wrong one would answer. Pick a name that sounds different.`,
    );
  }
  return name;
}
