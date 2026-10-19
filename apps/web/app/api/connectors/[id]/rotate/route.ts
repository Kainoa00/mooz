import { connectorUrl, requireOwnerKey, rotateConnector } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { assertSameOrigin, publicOrigin } from "@/lib/session";

/** A new link for the connector; the old one stops working at once. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { id } = await ctx.params;
    const { connector, secret } = rotateConnector(getDb(), requireOwnerKey(req), id);
    return Response.json(
      { connector, url: connectorUrl(publicOrigin(req), secret) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
