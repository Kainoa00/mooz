import { createHash, randomBytes, randomInt } from "node:crypto";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

function pick(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** A Meet-style room slug such as `kqv-tzpa-mwe` (~47 bits). */
export function newRoomSlug(): string {
  return `${pick(LETTERS, 3)}-${pick(LETTERS, 4)}-${pick(LETTERS, 3)}`;
}

/** A 256-bit url-safe secret for cookies and one-time codes. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** A prefixed random identifier, e.g. `p_3f9k...`. */
export function newId(prefix: string): string {
  return `${prefix}_${pick(ALNUM, 16)}`;
}

/** Secrets are stored hashed so a leaked database does not leak live credentials. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
