import { nameWords, ratio, sameWord, wakeWord } from "./addressing";
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
/** Whether two words are spelled nearly the same (the detector's spelling rule, not its sound one). */
const spelledAlike = (a: string, b: string) => a === b || (a.length >= 3 && b.length >= 3 && ratio(a, b) >= 90);

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
  // Latin letters drawn like plain ones: Atǀas (a click letter) reads Atlas, Ɗan reads Dan.
  ǀ: "l", ǁ: "ll", ƚ: "l", ɭ: "l", ɫ: "l", ȴ: "l", ɨ: "i", ʉ: "u", ꜰ: "f", ꞵ: "b", ƀ: "b",
  ꭓ: "x", ɲ: "n", ɾ: "r", ɼ: "r", ʂ: "s", ƙ: "k", ɓ: "b", ɗ: "d", ƴ: "y", ə: "e",
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

// Marks drawn like an apostrophe: the curly ones phones type, the ʻokina, primes, accents.
const APOSTROPHES = /[\u2018\u2019\u02b9\u02bb\u02bc\u02bd\u02be\u02bf\u02c8\ua78b\ua78c`\u00b4\u2032]/gu;

/**
 * Compatibility forms (fullwidth, circled…) and accents gone, joiners dropped, and anything drawn
 * like an apostrophe written as one (so "At’las" and "Atʻlas" are one word, as "At'las" is).
 * Before normalizing too: it would turn ´ into a space and an accent.
 */
function bare(name: string): string {
  return name
    .replace(APOSTROPHES, "'")
    .normalize("NFKC")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u200c\u200d]/g, "")
    .replace(APOSTROPHES, "'");
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
 * as I), which many fonts draw alike. Only where they would pass for each other: an I after a
 * small letter, or before one inside a word ("AtIas", "KaI"), and an l that starts a word, or
 * follows a capital with no small letter after it ("lris", "ARlA", "NovaAl"). A capital I that
 * starts a word (Ira, Ilham) and an l among small letters (Joel, Clara) are just themselves.
 */
function readings(name: string): string[] {
  const iAsL = name.replace(/(?<=\p{Ll})I|(?<=\p{L})I(?=\p{Ll})/gu, "l");
  const lAsI = name.replace(/(?<![\p{L}\p{N}])l|(?<=\p{Lu})l(?!\p{Ll})/gu, "I");
  return [foldName(name), foldNameByLook(name), foldNameByLook(iAsL), foldNameByLook(lAsI)];
}

interface Reading {
  folded: string;
  /** A reading by look (not by sound): letters no table knows may stand in for others. */
  byLook: boolean;
  /**
   * An l read as I: "lily" read as "Iily" is that only to the eye, so it matches by spelling
   * alone, not by the detector's sound rule (or it would be heard as Ilya).
   */
  bySpelling: boolean;
}

function readingsOf(name: string): Reading[] {
  const [sound, look, iAsL, lAsI] = readings(name);
  return [
    { folded: sound, byLook: false, bySpelling: false },
    { folded: look, byLook: true, bySpelling: false },
    { folded: iAsL, byLook: true, bySpelling: false },
    { folded: lAsI, byLook: true, bySpelling: lAsI !== look },
  ];
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

/**
 * Whether a word with Latin letters the tables don't know ("ꜳtlas") reads as `wake`: the same
 * length, with those letters (fewer than half of them) where the rest doesn't match.
 */
function readsAs(word: string, wake: string): boolean {
  const letters = [...word];
  const target = [...wake];
  if (letters.length !== target.length) return false;
  let unknown = 0;
  for (const [i, c] of letters.entries()) {
    if (c === target[i]) continue;
    if (c < "\x80" || !LATIN_SCRIPT.test(c)) return false;
    unknown++;
  }
  return unknown > 0 && unknown * 2 < letters.length;
}

/** The words of a folded name that still have letters beyond a to z, possessive and all. */
const unknownWords = (folded: string) =>
  (folded.match(/[\p{L}\p{N}']+/gu) ?? [])
    .filter((w) => /[^\x00-\x7f]/.test(w))
    .map((w) => w.replace(/'s$/, "").replace(/^'+|'+$/g, ""));

/**
 * Whether saying any word of `name` would be heard as `agent`'s wake word, either read any way
 * (an agent called "AtIas" is read as Atlas too).
 */
function heardAs(name: string, agent: string): boolean {
  const wakes = readingsOf(agent).flatMap(({ folded, bySpelling }) => {
    const word = wakeWord(folded);
    return word === undefined ? [] : [{ word, bySpelling }];
  });
  if (wakes.length === 0) return false;
  return readingsOf(name).some(
    (r) =>
      nameWords(r.folded).some((w) =>
        wakes.some((wake) => (r.bySpelling || wake.bySpelling ? spelledAlike(w, wake.word) : alike(w, wake.word))),
      ) ||
      (r.byLook && unknownWords(r.folded).some((w) => wakes.some((wake) => readsAs(w, wake.word)))),
  );
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
  const read = readings(name);
  if (takenNames.some((taken) => readings(taken.trim()).some((r) => read.includes(r)))) {
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
