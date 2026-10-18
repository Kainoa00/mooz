import { hostCookie, participantCookie, readCookie } from "./cookies";
import type { Db } from "./db";
import { HttpError } from "./http";
import { findParticipant, getRoom, isHost, type Participant, type Room } from "./rooms";

export function requireRoom(db: Db, slug: string): Room {
  const room = getRoom(db, slug);
  if (!room) throw new HttpError(404, "room_not_found", "No such meeting");
  return room;
}

export function requireHost(db: Db, req: Request, slug: string): Room {
  const room = requireRoom(db, slug);
  if (!isHost(db, slug, readCookie(req, hostCookie(slug)))) {
    throw new HttpError(403, "not_host", "Only the host can do that");
  }
  return room;
}

export function requireParticipant(db: Db, req: Request, slug: string): Participant {
  requireRoom(db, slug);
  const p = findParticipant(db, slug, readCookie(req, participantCookie(slug)));
  if (!p) throw new HttpError(401, "not_joined", "Join the meeting first");
  return p;
}

/**
 * The public origin of this server. MOOZ_PUBLIC_URL wins; otherwise it is derived
 * from the request (forwarded headers are only trustworthy behind your own proxy).
 */
export function publicOrigin(req: Request): string {
  const configured = process.env.MOOZ_PUBLIC_URL;
  if (configured) return new URL(configured).origin;
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

/**
 * Reject cross-site requests on cookie-authenticated mutations. SameSite=Lax
 * cookies still flow from sibling sites (other subdomains or ports), so check
 * what the browser says about where the request came from.
 */
export function assertSameOrigin(req: Request): void {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite) {
    if (fetchSite === "same-origin" || fetchSite === "none") return;
    throw new HttpError(403, "cross_site", "Cross-site requests are not allowed");
  }
  // Older browsers without Fetch Metadata: fall back to comparing Origin.
  const origin = req.headers.get("origin");
  if (origin && origin !== publicOrigin(req)) {
    throw new HttpError(403, "cross_site", "Cross-site requests are not allowed");
  }
}
