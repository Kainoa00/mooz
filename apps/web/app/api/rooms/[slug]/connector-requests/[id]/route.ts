import { connectorJoinStatus } from "@/lib/connector-agents";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { requireParticipant } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Polled by the owner's tab until the host decides. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }): Promise<Response> {
  try {
    const { slug, id } = await ctx.params;
    const db = getDb();
    const status = connectorJoinStatus(db, requireParticipant(db, req, slug), id);
    return Response.json({ status }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
