import { hostCookie, participantCookie, readCookie, sessionCookie } from "@/lib/cookies";
import { getDb } from "@/lib/db";
import { HttpError, errorResponse, readJson } from "@/lib/http";
import { livekitConfig, mintHumanToken } from "@/lib/livekit";
import { parseDisplayName } from "@/lib/names";
import { addParticipant, getRoom, isHost } from "@/lib/rooms";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await ctx.params;
    const db = getDb();
    if (!getRoom(db, slug)) throw new HttpError(404, "room_not_found", "No such meeting");

    const name = parseDisplayName((await readJson(req)).name);
    const host = isHost(db, slug, readCookie(req, hostCookie(slug)));
    const participant = addParticipant(db, { slug, name, isHost: host });
    const token = await mintHumanToken({ room: slug, identity: participant.identity, name });

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
