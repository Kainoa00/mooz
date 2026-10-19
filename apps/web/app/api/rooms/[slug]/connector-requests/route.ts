import { requestConnectorJoin } from "@/lib/connector-agents";
import { requireOwnerKey } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { errorResponse, readJson } from "@/lib/http";
import { removeAllFromRooms } from "@/lib/kicks";
import { assertSameOrigin, requireParticipant } from "@/lib/session";

/** The owner brings their connector into this meeting; the host then approves it. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug } = await ctx.params;
    const db = getDb();
    const owner = requireParticipant(db, req, slug);
    const body = await readJson(req);
    const { requestId, status, superseded } = requestConnectorJoin(db, owner, requireOwnerKey(req), body.connectorId);
    await removeAllFromRooms(superseded);
    return Response.json({ requestId, status }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
