import { hostCookie, participantCookie, readCookie, sessionCookie } from "@/lib/cookies";
import { getDb } from "@/lib/db";
import { errorResponse, readJson } from "@/lib/http";
import { livekitConfig, mintHumanToken } from "@/lib/livekit";
import { parseDisplayName } from "@/lib/names";
import { activeAgentNames } from "@/lib/agents";
import { addParticipant, isHost } from "@/lib/rooms";
import { assertSameOrigin, requireRoom } from "@/lib/session";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await ctx.params;
    assertSameOrigin(req);
    const db = getDb();
    const room = requireRoom(db, slug);

    const name = parseDisplayName((await readJson(req)).name, activeAgentNames(db, slug));
    const host = isHost(db, slug, readCookie(req, hostCookie(slug)));
    const participant = addParticipant(db, { slug, name, isHost: host });
    const token = await mintHumanToken({ room: room.livekitRoom, identity: participant.identity, name });

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
