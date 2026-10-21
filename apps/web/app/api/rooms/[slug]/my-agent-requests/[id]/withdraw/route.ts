import { MY_REQUESTS_PER_MINUTE, withdrawMyAgentRequest } from "@/lib/agents";
import { forgetAgent } from "@/lib/connector-queue";
import { getDb } from "@/lib/db";
import { leaveFloor } from "@/lib/floor";
import { HttpError, errorResponse, readJson } from "@/lib/http";
import { removeFromRoom } from "@/lib/livekit";
import { allow } from "@/lib/rate-limit";
import "@/lib/room-state"; // tells the meeting when the floor changes
import { assertSameOrigin, requireParticipant, requireRoom } from "@/lib/session";

/**
 * "Not mine": the owner cancels a request made with their code. A waiting one is declined;
 * an agent that's in is removed, as when the host removes it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, id } = await ctx.params;
    const db = getDb();
    const room = requireRoom(db, slug);
    const me = requireParticipant(db, req, slug);
    await readJson(req, 64); // JSON only: a plain form post can't forge it
    if (!allow(`my-requests:${me.identity}`, MY_REQUESTS_PER_MINUTE, 60_000)) {
      throw new HttpError(429, "rate_limited", "Too many clicks just now");
    }
    const { remove } = withdrawMyAgentRequest(db, me, id);
    if (remove) {
      forgetAgent(remove);
      leaveFloor(slug, remove);
      await removeFromRoom(room.livekitRoom, remove);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
