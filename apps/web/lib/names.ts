import { HttpError } from "./http";

const MAX_DISPLAY_NAME = 40;

// Control and format characters (zero-width, bidi overrides) let a name render as
// something else; the robot marker is reserved for agents.
const DECEPTIVE = /[\p{Cc}\p{Cf}]|🤖/u;

/**
 * Trim and validate a human display name. People cannot use the agent marker,
 * invisible characters, or the name of an agent in the meeting (its wake word).
 */
export function parseDisplayName(value: unknown, agentNames: readonly string[] = []): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_name", "Name is required");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new HttpError(400, "invalid_name", "Name is required");
  if (name.length > MAX_DISPLAY_NAME) {
    throw new HttpError(400, "invalid_name", `Name must be at most ${MAX_DISPLAY_NAME} characters`);
  }
  if (DECEPTIVE.test(name)) {
    throw new HttpError(400, "invalid_name", "Names cannot contain 🤖 or invisible characters");
  }
  if (agentNames.some((agent) => agent.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, "name_taken", `An agent in this meeting is called "${name}"`);
  }
  return name;
}

// An agent wakes up when its name is said, so names that people say all the
// time (or that address everyone) would trigger it constantly.
const RESERVED = new Set([
  "mooz", "agent", "agents", "everyone", "everybody", "all", "anyone", "somebody", "someone",
  "hey", "hi", "hello", "ok", "okay", "yes", "yeah", "no", "so", "well", "right", "sure",
  "you", "me", "we", "us", "they", "the", "and", "but", "bot", "ai", "assistant", "computer",
  "host", "guest", "chat", "meeting",
]);

const AGENT_NAME = /^[A-Za-z][A-Za-z0-9' -]{1,23}$/;

/**
 * Validate an agent's name: 2–24 characters, starting with a letter, not a
 * reserved word, and not already used by any agent or person in the meeting.
 */
export function parseAgentName(value: unknown, takenNames: readonly string[]): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!AGENT_NAME.test(name)) {
    throw new HttpError(
      400,
      "invalid_agent_name",
      "Agent names are 2–24 characters: letters, numbers, spaces, apostrophes or dashes, starting with a letter",
    );
  }
  const key = name.toLowerCase();
  if (RESERVED.has(key)) {
    throw new HttpError(400, "reserved_name", `"${name}" is too common to use as an agent's wake name`);
  }
  if (takenNames.some((taken) => taken.trim().toLowerCase() === key)) {
    throw new HttpError(409, "name_taken", `Someone in this meeting is already called "${name}"`);
  }
  return name;
}
