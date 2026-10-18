import { listPendingRequests } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { requireHost } from "@/lib/session";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await ctx.params;
    const db = getDb();
    requireHost(db, req, slug);
    return Response.json({ requests: listPendingRequests(db, slug) });
  } catch (err) {
    return errorResponse(err);
  }
}
