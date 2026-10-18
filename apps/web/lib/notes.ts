import type { Db } from "./db";

/**
 * Meeting notes consent. Notes are off until the host allows them for a meeting, and
 * anyone can leave themselves out. Both live here and in LiveKit (room metadata and a
 * participant attribute), which only this server can set, so an agent can't fake them.
 */

export function getNotesPolicy(db: Db, slug: string): boolean {
  const row = db.prepare("SELECT notes_allowed FROM rooms WHERE slug = ?").get(slug) as
    | { notes_allowed: number }
    | undefined;
  return row?.notes_allowed === 1;
}

export function setNotesPolicy(db: Db, slug: string, allowed: boolean): void {
  db.prepare("UPDATE rooms SET notes_allowed = ? WHERE slug = ?").run(allowed ? 1 : 0, slug);
}

export function getNotesOptOut(db: Db, identity: string): boolean {
  const row = db.prepare("SELECT notes_opt_out FROM participants WHERE identity = ?").get(identity) as
    | { notes_opt_out: number }
    | undefined;
  return row?.notes_opt_out === 1;
}

export function setNotesOptOut(db: Db, identity: string, optOut: boolean): void {
  db.prepare("UPDATE participants SET notes_opt_out = ? WHERE identity = ?").run(optOut ? 1 : 0, identity);
}

/** The LiveKit room metadata agents read to learn whether notes are allowed. */
export function notesMetadata(allowed: boolean): string {
  return JSON.stringify({ notes_allowed: allowed });
}

/** The participant attribute agents read: "1" means leave this person out. */
export { NOTES_OPT_OUT_ATTRIBUTE } from "./notes-protocol";
