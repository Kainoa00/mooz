import { revokeConnectorAgents } from "@/lib/connector-agents";
import { deleteConnector, getOwned, requireOwnerKey } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { removeAllFromRooms } from "@/lib/kicks";
import { assertSameOrigin } from "@/lib/session";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { id } = await ctx.params;
    const db = getDb();
    const owner = requireOwnerKey(req);
    getOwned(db, owner, id);
    // Out of any meeting first: a deleted connector's agent must not linger.
    const kicks = revokeConnectorAgents(db, id);
    deleteConnector(db, owner, id);
    await removeAllFromRooms(kicks);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
