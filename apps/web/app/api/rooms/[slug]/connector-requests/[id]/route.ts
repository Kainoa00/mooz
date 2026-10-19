import { connectorJoinStatus, withdrawConnector } from "@/lib/connector-agents";
import { requireOwnerKey } from "@/lib/connectors";
import { forgetAgent } from "@/lib/connector-queue";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { removeAllFromRooms } from "@/lib/kicks";
import { assertSameOrigin, requireParticipant } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Polled by the owner's tab until the host decides. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }): Promise<Response> {
  try {
    const { slug, id } = await ctx.params;
    const db = getDb();
    const status = connectorJoinStatus(db, requireParticipant(db, req, slug), requireOwnerKey(req), id);
    return Response.json({ status }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** The owner cancels the request, or takes their agent out of the meeting. */
export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, id } = await ctx.params;
    const db = getDb();
    const kick = withdrawConnector(db, requireParticipant(db, req, slug), requireOwnerKey(req), id);
    if (kick) {
      forgetAgent(kick.identity);
      await removeAllFromRooms([kick]);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
