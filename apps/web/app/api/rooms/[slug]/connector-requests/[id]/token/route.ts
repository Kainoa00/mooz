import { connectorAgentFor } from "@/lib/connector-agents";
import { requireOwnerKey } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { livekitConfig, mintAgentToken } from "@/lib/livekit";
import { assertSameOrigin, requireParticipant } from "@/lib/session";

/**
 * The approved connector agent's token, for its owner's tab. Unlike a bridge's
 * one-time token, the tab may ask again (after a reload) while the agent stays
 * approved: both the participant and the owner cookie must match.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, id } = await ctx.params;
    const db = getDb();
    const owner = requireParticipant(db, req, slug);
    requireOwnerKey(req);
    const agent = connectorAgentFor(db, owner, id);
    return Response.json(
      { token: await mintAgentToken(agent), url: livekitConfig().url, identity: agent.identity, name: agent.name },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
