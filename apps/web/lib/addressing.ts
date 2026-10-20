/**
 * Whether something said or typed in the meeting is addressed to an agent: a line-for-line
 * port of the bridge's detector (mooz_agent/addressing.py), for connector agents, whose ears
 * run in their owner's tab. Both run the same cases (bridge/tests/addressing_cases.json).
 *
 * Being mentioned ("I asked Atlas yesterday") is not being addressed ("Atlas, what's
 * blocking the deploy?"). The name (or a likely mis-transcription of it) must open the
 * utterance, optionally after a greeting, or close a question. `@Name` in chat always works.
 */

const words = (s: string) => new Set(s.split(" "));

const GREETINGS = words("hey hi hello ok okay yo so um uh and well oh alright right");
// A name followed directly by these (without a comma) is being talked about.
const REPORTING = words(
  "said says told tells thinks thought mentioned was wasn't is isn't has had did didn't " +
    "does doesn't knows knew wrote suggested project team",
);
const QUESTION_OPENERS = words(
  "what why how when where who which whose can could would will is are am do does did " +
    "should shall any have has was were",
);
// A name right after these is the object of a sentence, not someone being spoken to.
const OBJECT_MARKERS = words("ask asked tell told to about with from for the at of by");
const BROADCAST_VOICE = ["agents"];
const BROADCAST_CHAT = ["everyone", "agents"];
// A heard word matches the name if it sounds alike AND is spelled close, or is spelled
// very close. Sound alone is too loose ("could" sounds like "Claude").
const SOUND_ALIKE_MIN_RATIO = 75;
const SPELLED_ALIKE_MIN_RATIO = 90;

const EDGE_PUNCT = " \t,.:;!-";

export type Via = "voice" | "chat";

/** The agent was addressed. `question` may be empty ("Hey Atlas."). */
export interface Addressed {
  question: string;
  via: Via;
}

interface Token {
  norm: string;
  possessive: boolean;
  start: number;
  end: number;
}

const lstrip = (s: string, chars: string) => {
  let i = 0;
  while (i < s.length && chars.includes(s[i])) i++;
  return s.slice(i);
};
const rstrip = (s: string, chars: string) => {
  let i = s.length;
  while (i > 0 && chars.includes(s[i - 1])) i--;
  return s.slice(0, i);
};
const strip = (s: string, chars: string) => rstrip(lstrip(s, chars), chars);

/** A crude sound-alike key: first letter, then consonants with near-homophones merged. */
export function phoneticKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  for (const [src, dst] of [["ph", "f"], ["ck", "k"], ["q", "k"], ["c", "k"], ["z", "s"], ["x", "ks"]]) {
    w = w.replaceAll(src, dst);
  }
  const tail = w.slice(1).replace(/[aeiouyhw]/g, "");
  let key = w[0];
  for (const ch of tail) if (ch !== key[key.length - 1]) key += ch;
  return key;
}

/** A name's words as the detector compares them: lowercased, apostrophes and "'s" dropped. */
export function nameWords(name: string): string[] {
  return tokens(name).map((t) => t.norm);
}

/**
 * The words that wake an agent on their own: its name if it's one word, else the last word
 * ("Zach's Grok" answers to "Grok"; "Zach" alone doesn't wake it).
 */
export function wakeWord(name: string): string | undefined {
  return nameWords(name).at(-1);
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9']+/g)) {
    const raw = m[0].toLowerCase();
    const possessive = raw.endsWith("'s");
    const norm = possessive ? raw.slice(0, -2) : strip(raw, "'");
    out.push({ norm, possessive, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** rapidfuzz's fuzz.ratio: 100 × 2·LCS / (len a + len b). */
export function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 100;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    prev = row;
  }
  return (200 * prev[b.length]) / (a.length + b.length);
}

/** Whether the detector would hear `heard` as the wake word `wake` (spelled or sounding alike). */
export function sameWord(heard: string, wake: string): boolean {
  if (heard === wake) return true;
  if (heard.length < 3) return false;
  const r = ratio(heard, wake);
  if (r >= SPELLED_ALIKE_MIN_RATIO) return true;
  return r >= SOUND_ALIKE_MIN_RATIO && phoneticKey(heard) === phoneticKey(wake);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Phones type curly apostrophes (U+2019); match them like straight ones.
const normalizePossessives = (text: string) => text.replaceAll("’", "'");

export class AddressDetector {
  private readonly forms: string[][];
  private readonly chatMention: RegExp;

  constructor(readonly name: string) {
    const nameWords = tokens(name).map((t) => t.norm);
    this.forms = [nameWords];
    if (nameWords.length > 1) this.forms.push(nameWords.slice(-1)); // "Zach's Grok" answers to "Grok"
    const mentionable = [name.trim(), ...this.forms.slice(1).map((f) => f.join(" ")), ...BROADCAST_CHAT];
    // Python's \w and \b know every script; spelled out here, so "café@Grok" isn't a mention in either.
    this.chatMention = new RegExp(
      `(?<![\\p{L}\\p{N}_.@])@(${mentionable.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}_])`,
      "iu",
    );
  }

  check(text: string, via: Via): Addressed | null {
    if (via === "chat") {
      const mention = this.chatMention.exec(normalizePossessives(text));
      if (mention) {
        const rest = strip(text.slice(0, mention.index) + text.slice(mention.index + mention[0].length), EDGE_PUNCT + " ");
        return { question: rest.replace(/\s+/g, " "), via };
      }
    }
    return this.checkSpoken(text, via);
  }

  private checkSpoken(text: string, via: Via): Addressed | null {
    const toks = tokens(text);
    if (!toks.length) return null;
    const forms = [...this.forms, ...BROADCAST_VOICE.map((w) => [w])];
    for (const form of forms) {
      const strict = form.length === 1 && BROADCAST_VOICE.includes(form[0]);
      for (let i = 0; i + form.length <= toks.length; i++) {
        if (!form.every((w, k) => sameWord(toks[i + k].norm, w))) continue;
        const found = this.judge(text, toks, i, i + form.length - 1, via, strict);
        if (found) return found;
      }
    }
    return null;
  }

  private judge(text: string, toks: Token[], first: number, last: number, via: Via, strict: boolean): Addressed | null {
    const nameEnd = toks[last].end;
    const before = toks.slice(0, first);
    const after = toks.slice(last + 1);
    const commaAfter = /^\s*[,.:;!?]/.test(text.slice(nameEnd));
    const commaBefore = /[,;:]\s*$/.test(text.slice(0, toks[first].start));

    const opens = before.length <= 3 && before.every((t) => GREETINGS.has(t.norm));
    // "Agents" is an ordinary word, so as a wake word it must be set off: "Hey agents, ..."
    if (strict && !(opens && commaAfter)) return null;
    if (opens) {
      if (toks[last].possessive) return null;
      if (after.length && !commaAfter && REPORTING.has(after[0].norm)) return null;
      return { question: lstrip(text.slice(nameEnd), EDGE_PUNCT + "?").trim(), via };
    }

    const closes = !after.length && !OBJECT_MARKERS.has(before[before.length - 1].norm);
    const isQuestion = text.trimEnd().endsWith("?") || QUESTION_OPENERS.has(toks[0].norm);
    // "..., Atlas." closing a request is a vocative even when it is not a question.
    if (closes && (isQuestion || commaBefore)) {
      return { question: rstrip(text.slice(0, toks[first].start), EDGE_PUNCT + " "), via };
    }
    return null;
  }
}
