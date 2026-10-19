import { revokeAgent } from "@/lib/agents";
import { forgetAgent } from "@/lib/connector-queue";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { removeFromRoom } from "@/lib/livekit";
import { assertSameOrigin, requireHost } from "@/lib/session";

/** Host-only: remove an agent from the meeting and make sure it cannot rejoin. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; identity: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, identity } = await ctx.params;
    const db = getDb();
    const room = requireHost(db, req, slug);
    revokeAgent(db, { slug, agentIdentity: identity });
    forgetAgent(identity);
    await removeFromRoom(room.livekitRoom, identity);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
