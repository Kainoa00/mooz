import { hostCookie, participantCookie, readCookie } from "./cookies";
import type { Db } from "./db";
import { HttpError } from "./http";
import { findParticipant, getRoom, isHost, type Participant } from "./rooms";

export function requireRoom(db: Db, slug: string): void {
  if (!getRoom(db, slug)) throw new HttpError(404, "room_not_found", "No such meeting");
}

export function requireHost(db: Db, req: Request, slug: string): void {
  requireRoom(db, slug);
  if (!isHost(db, slug, readCookie(req, hostCookie(slug)))) {
    throw new HttpError(403, "not_host", "Only the host can do that");
  }
}

export function requireParticipant(db: Db, req: Request, slug: string): Participant {
  requireRoom(db, slug);
  const p = findParticipant(db, slug, readCookie(req, participantCookie(slug)));
  if (!p) throw new HttpError(401, "not_joined", "Join the meeting first");
  return p;
}

/** The public origin of this server, honoring a reverse proxy's forwarded headers. */
export function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}
