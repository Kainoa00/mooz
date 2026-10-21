import { hostCookie, participantCookie, readCookie, sessionCookie } from "@/lib/cookies";
import { getDb } from "@/lib/db";
import { HttpError, errorResponse, readJson, SMALL_JSON_BYTES } from "@/lib/http";
import { livekitConfig, mintHumanToken } from "@/lib/livekit";
import { parseDisplayName } from "@/lib/names";
import { activeAgentNames } from "@/lib/agents";
import { getNotesOptOut } from "@/lib/notes";
import { allow } from "@/lib/rate-limit";
import { addParticipant, findParticipant, isHost, renameParticipant } from "@/lib/rooms";
import { assertSameOrigin, requireRoom } from "@/lib/session";

/** Joins (and rejoins) a minute per meeting. */
export const JOINS_PER_MINUTE = 30;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await ctx.params;
    assertSameOrigin(req);
    const db = getDb();
    const room = requireRoom(db, slug);
    if (!allow(`joins:${slug}`, JOINS_PER_MINUTE, 60_000)) {
      throw new HttpError(429, "rate_limited", "Lots of people are joining this meeting just now. Try again in a minute.");
    }

    const body = await readJson(req, SMALL_JSON_BYTES);
    const name = parseDisplayName(body.name, activeAgentNames(db, slug));
    const host = isHost(db, slug, readCookie(req, hostCookie(slug)));
    // A reload in the same tab rejoins as the same person, so agents keep recognizing
    // their owner. The tab says who it was, and that must still be whom the cookie names:
    // another tab in the same browser may have joined since and taken the cookie over.
    const secret = readCookie(req, participantCookie(slug));
    const cookieParticipant = typeof body.rejoin === "string" ? findParticipant(db, slug, secret) : undefined;
    const returning = cookieParticipant?.identity === body.rejoin ? cookieParticipant : undefined;
    const participant = returning
      ? { ...renameParticipant(db, returning, name, host), secret: secret as string }
      : addParticipant(db, { slug, name, isHost: host });
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
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
