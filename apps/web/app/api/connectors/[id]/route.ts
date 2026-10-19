import { deleteConnector, requireOwnerKey } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { assertSameOrigin } from "@/lib/session";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { id } = await ctx.params;
    deleteConnector(getDb(), requireOwnerKey(req), id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
