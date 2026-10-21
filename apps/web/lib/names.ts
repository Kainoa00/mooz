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
// be heard as an agent's either way. These are the common lookalikes, not Unicode's whole
// confusables list. Capitals are read by their own shape first (Greek Ν is N, though ν is v).
const CAPITALS: Record<string, string> = {
  Α: "a", Β: "b", Ε: "e", Ζ: "z", Η: "h", Ι: "i", Κ: "k", Μ: "m", Ν: "n", Ο: "o", Ρ: "p",
  Τ: "t", Υ: "y", Χ: "x", А: "a", В: "b", Е: "e", К: "k", М: "m", Н: "h", О: "o", Р: "p",
  С: "c", Т: "t", У: "y", Х: "x", Ѕ: "s", І: "i", Ј: "j", Һ: "h", Ӏ: "l", Ү: "y", Ԛ: "q",
  Ԝ: "w", Օ: "o", Ս: "u",
};
const LOOKS: Record<string, string> = {
  ...LATIN,
  ɩ: "i", ȷ: "j", ɵ: "o", "0": "o", "1": "l",
  а: "a", в: "b", г: "r", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", п: "n", р: "p",
  с: "c", т: "t", у: "y", х: "x", ш: "w", ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d", ԛ: "q",
  ԝ: "w", һ: "h", ӏ: "l", ү: "y", α: "a", β: "b", ε: "e", ζ: "z", η: "n", ι: "i", κ: "k",
  μ: "u", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ϲ: "c", ϳ: "j", օ: "o", ս: "u",
  ց: "g", հ: "h", ո: "n",
  // Cherokee capitals (and so their small forms) that look like Latin ones: ᎪᎢᏞᎪᏚ reads ATLAS.
  Ꭺ: "a", Ᏼ: "b", Ꮯ: "c", Ꭰ: "d", Ꭼ: "e", Ꮐ: "g", Ꮋ: "h", Ꭵ: "i", Ꭻ: "j", Ꮶ: "k", Ꮮ: "l",
  Ꮇ: "m", Ꮲ: "p", Ꭱ: "r", Ꮪ: "s", Ꭲ: "t", Ꮩ: "v", Ꮃ: "w", Ꮓ: "z",
  // Lisu, which has only capitals: ꓮꓔꓡꓮꓢ reads ATLAS too.
  ꓮ: "a", ꓐ: "b", ꓚ: "c", ꓓ: "d", ꓰ: "e", ꓝ: "f", ꓖ: "g", ꓧ: "h", ꓲ: "i", ꓙ: "j", ꓗ: "k",
  ꓡ: "l", ꓟ: "m", ꓠ: "n", ꓳ: "o", ꓑ: "p", ꓣ: "r", ꓢ: "s", ꓔ: "t", ꓴ: "u", ꓦ: "v", ꓪ: "w",
  ꓫ: "x", ꓬ: "y", ꓜ: "z",
};

/** Compatibility forms (fullwidth, circled…) and accents gone, joiners dropped. */
function bare(name: string): string {
  return name.normalize("NFKC").normalize("NFKD").replace(/\p{M}/gu, "").replace(/[\u200c\u200d]/g, "");
}

const plain = (name: string) => bare(name).toLowerCase();

/**
 * A name as it sounds in plain Latin letters (what speech-to-text writes when it's said):
 * fullwidth and other lookalike forms, accents, and Cyrillic and Greek letters folded.
 */
export function foldName(name: string): string {
  return plain(name).replace(/[^\x00-\x7f]/gu, (c) => TRANSLIT[c] ?? LATIN[c] ?? c);
}

/** A name as it looks in plain Latin letters (what someone reading it would say). */
export function foldNameByLook(name: string): string {
  return [...bare(name)]
    .map((c) => CAPITALS[c] ?? LOOKS[c] ?? LOOKS[c.toUpperCase()] ?? LOOKS[c.toLowerCase()] ?? c.toLowerCase())
    .join("");
}

/**
 * The ways a name can be read: as it sounds, as it looks, and with a capital I read as l (and l
 * as I), which many fonts draw alike ("AtIas").
 */
function readings(name: string): string[] {
  return [foldName(name), foldNameByLook(name), foldNameByLook(name.replace(/I/g, "l")), foldNameByLook(name.replace(/l/g, "I"))];
}

const LATIN_SCRIPT = /\p{Script=Latin}/u;
const ANY_SCRIPT = /[\p{Script=Common}\p{Script=Inherited}]/u; // ʻ in Hawaiʻi, ʼ, marks

/**
 * Whether a word mixes Latin letters with letters of another alphabet ("Grօk", with an Armenian
 * o): such a word can look like an agent's name and still not match it here. Every Latin letter
 * counts (Əliyev, Ɔdɛɛ, Ƙano), and so do letters shared by all alphabets (Hawaiʻi).
 */
function mixesAlphabets(name: string): boolean {
  return (plain(name).match(/\p{L}+/gu) ?? []).some((word) => {
    const letters = [...word].filter((c) => !ANY_SCRIPT.test(c));
    return letters.some((c) => LATIN_SCRIPT.test(c)) && !letters.every((c) => LATIN_SCRIPT.test(c));
  });
}

/** Whether saying any word of `name` would be heard as `agent`'s wake word (read any way). */
function heardAs(name: string, agent: string): boolean {
  const wake = wakeWord(foldName(agent));
  if (wake === undefined) return false;
  return readings(name).some((folded) => nameWords(folded).some((w) => alike(w, wake)));
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
  if (takenNames.some((taken) => readings(taken.trim()).includes(key))) {
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
