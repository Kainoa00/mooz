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
  if (agentNames.some((a) => heardAs(name, a))) {
    throw new HttpError(
      409,
      "name_taken",
      `"${name}" sounds like the name of an agent in this meeting: saying it would wake the agent. Pick another name.`,
    );
  }
  if (mixesAlphabets(name)) {
    throw new HttpError(400, "invalid_name", "Use one alphabet within each word of your name");
  }
  return name;
}

/** Whether two words would be heard as each other, either way round. */
const alike = (a: string, b: string) => a === b || sameWord(a, b) || sameWord(b, a);

// How Cyrillic and Greek letters sound in Latin ones, so "Атлас" (or "Аtlas", with one
// Cyrillic letter) is heard as Atlas.
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", ё: "e", є: "ye", ж: "zh", з: "z", и: "i",
  і: "i", ї: "yi", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e",
  ю: "yu", я: "ya", α: "a", β: "b", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i",
  κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y",
  φ: "f", χ: "ch", ψ: "ps", ω: "o",
};

// Latin letters that don't break down into a plain one (and look and sound like it).
const LATIN: Record<string, string> = {
  ı: "i", ł: "l", ø: "o", đ: "d", ħ: "h", ŧ: "t", ß: "ss", æ: "ae", œ: "oe", þ: "th", ð: "d",
  ŋ: "n", ĸ: "k", ſ: "s", ɑ: "a", ɡ: "g", ɢ: "g", ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e",
  ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m", ɴ: "n", ᴏ: "o", ᴘ: "p", ʀ: "r", ꜱ: "s",
  ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
};

// How letters of other alphabets look in Latin ones, whatever they sound like: Cyrillic "Сora"
// reads as Cora, though С sounds like S. Read along with TRANSLIT: a name clashes if it would
// be heard as an agent's either way.
const LOOKS: Record<string, string> = {
  ...LATIN,
  а: "a", в: "b", г: "r", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", п: "n", р: "p",
  с: "c", т: "t", у: "y", х: "x", ш: "w", ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d", ԛ: "q",
  ԝ: "w", α: "a", β: "b", ε: "e", ζ: "z", η: "h", ι: "i", κ: "k", μ: "m", ν: "v", ο: "o",
  ρ: "p", τ: "t", υ: "u", χ: "x", օ: "o", ս: "u", ց: "g", հ: "h", ո: "n",
  // Cherokee capitals (and so their small forms) that look like Latin ones: ᎪᎢᏞᎪᏚ reads ATLAS.
  Ꭺ: "a", Ᏼ: "b", Ꮯ: "c", Ꭰ: "d", Ꭼ: "e", Ꮐ: "g", Ꮋ: "h", Ꭵ: "i", Ꭻ: "j", Ꮶ: "k", Ꮮ: "l",
  Ꮇ: "m", Ꮲ: "p", Ꭱ: "r", Ꮪ: "s", Ꭲ: "t", Ꮩ: "v", Ꮃ: "w", Ꮓ: "z",
};

/** Compatibility forms (fullwidth, circled…) and accents gone, joiners dropped, lowercase. */
function plain(name: string): string {
  return name.normalize("NFKC").normalize("NFKD").replace(/\p{M}/gu, "").replace(/[\u200c\u200d]/g, "").toLowerCase();
}

/**
 * A name as it sounds in plain Latin letters (what speech-to-text writes when it's said):
 * fullwidth and other lookalike forms, accents, and Cyrillic and Greek letters folded.
 */
export function foldName(name: string): string {
  return plain(name).replace(/[^\x00-\x7f]/gu, (c) => TRANSLIT[c] ?? LATIN[c] ?? c);
}

/** A name as it looks in plain Latin letters (what someone reading it would say). */
export function foldNameByLook(name: string): string {
  return plain(name).replace(/[^\x00-\x7f]/gu, (c) => LOOKS[c] ?? LOOKS[c.toUpperCase()] ?? c);
}

/**
 * Whether a word mixes Latin letters with others that don't read as Latin ("Grօk", with an
 * Armenian o): such a word can look like an agent's name and still not match it here.
 */
function mixesAlphabets(name: string): boolean {
  const latin = (c: string) => /[a-z]/.test(c) || c in LATIN;
  return (plain(name).match(/\p{L}+/gu) ?? []).some((word) => {
    const letters = [...word];
    return letters.some(latin) && !letters.every(latin);
  });
}

/** Whether saying any word of `name` would be heard as `agent`'s wake word (read either way). */
function heardAs(name: string, agent: string): boolean {
  const wake = wakeWord(foldName(agent));
  if (wake === undefined) return false;
  return [foldName(name), foldNameByLook(name)].some((folded) => nameWords(folded).some((w) => alike(w, wake)));
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
      "Agent names are 3–24 characters: letters, numbers, spaces, apostrophes or dashes, starting with a letter",
    );
  }
  const key = name.toLowerCase();
  const wake = wakeWord(name) ?? "";
  if (RESERVED.has(key) || RESERVED.has(wake) || COMMON_WORDS.has(wake)) {
    throw new HttpError(400, "reserved_name", `"${name}" is too common to use as an agent's wake name`);
  }
  if (wake.replace(/[^a-z]/g, "").length < 3) {
    throw new HttpError(400, "invalid_agent_name", "An agent's name needs a last word with at least 3 letters");
  }
  if (takenNames.some((taken) => foldName(taken.trim()) === key || foldNameByLook(taken.trim()) === key)) {
    throw new HttpError(409, "name_taken", `Someone in this meeting is already called "${name}"`);
  }
  // Which name it clashes with isn't said: the asker may not be able to see everyone who counts.
  if (takenNames.some((taken) => heardAs(taken, name)) || agents.some((agent) => heardAs(name, agent))) {
    throw new HttpError(
      409,
      "name_taken",
      `"${name}" sounds too much like someone already in this meeting: the wrong one would answer. Pick a name that sounds different.`,
    );
  }
  return name;
}
