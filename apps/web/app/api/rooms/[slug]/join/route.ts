import { maybeSweep } from "@/lib/cleanup";
import { hostCookie, participantCookie, readCookie, sessionCookie } from "@/lib/cookies";
import { getDb } from "@/lib/db";
import { HttpError, errorResponse, readJson, SMALL_JSON_BYTES } from "@/lib/http";
import { livekitConfig, mintHumanToken } from "@/lib/livekit";
import { parseDisplayName } from "@/lib/names";
import { activeAgentNames, assertRoomForName } from "@/lib/agents";
import { getNotesOptOut } from "@/lib/notes";
import { allow } from "@/lib/rate-limit";
import { addParticipant, findParticipant, isHost, renameParticipant, touchRoom } from "@/lib/rooms";
import { assertSameOrigin, requireRoom } from "@/lib/session";

/**
 * Joins a minute per meeting, counted apart for the host and for each person coming back (a
 * reload), so a stranger with the link who joins over and over can't keep them out.
 */
export const JOINS_PER_MINUTE = 30;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await ctx.params;
    assertSameOrigin(req);
    const db = getDb();
    maybeSweep(db); // first, so a room idle for 30 days is gone
    const room = requireRoom(db, slug);

    const body = await readJson(req, SMALL_JSON_BYTES);
    const hostSecret = readCookie(req, hostCookie(slug));
    const host = isHost(db, slug, hostSecret);
    // A reload in the same tab rejoins as the same person, so agents keep recognizing
    // their owner. The tab says who it was, and that must still be whom the cookie names:
    // another tab in the same browser may have joined since and taken the cookie over.
    const secret = readCookie(req, participantCookie(slug));
    const cookieParticipant = typeof body.rejoin === "string" ? findParticipant(db, slug, secret) : undefined;
    const returning = cookieParticipant?.identity === body.rejoin ? cookieParticipant : undefined;
    const key = returning ? `rejoins:${returning.identity}` : host ? `joins-host:${slug}` : `joins:${slug}`;
    if (!allow(key, JOINS_PER_MINUTE, 60_000)) {
      throw new HttpError(429, "rate_limited", "Lots of people are joining this meeting just now. Try again in a minute.");
    }
    // No exception for someone coming back under their own name: while they're away for a
    // moment it's held for them, and after that an agent that sounds like it may have come in.
    const name = parseDisplayName(body.name, activeAgentNames(db, slug));
    if (!returning) assertRoomForName(db, slug, host);
    const participant = returning
      ? { ...renameParticipant(db, returning, name, host), secret: secret as string }
      : addParticipant(db, { slug, name, isHost: host });
    // Each join keeps the room, and the host's (and this person's) session, for another day.
    touchRoom(db, slug, host);
    const token = await mintHumanToken({
      room: room.livekitRoom,
      identity: participant.identity,
      name,
      notesOptOut: getNotesOptOut(db, participant.identity),
    });

    const res = Response.json({
      token,
      url: livekitConfig().url,
      identity: participant.identity,
      isHost: host,
    });
    res.headers.append("set-cookie", sessionCookie(req, participantCookie(slug), participant.secret));
    if (host && hostSecret) res.headers.append("set-cookie", sessionCookie(req, hostCookie(slug), hostSecret));
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
