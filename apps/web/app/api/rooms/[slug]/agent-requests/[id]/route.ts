import { decideAgentRequest } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { HttpError, errorResponse, readJson } from "@/lib/http";
import { assertSameOrigin, requireHost } from "@/lib/session";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, id } = await ctx.params;
    const db = getDb();
    requireHost(db, req, slug);
    const { decision } = await readJson(req);
    if (decision !== "approve" && decision !== "deny") {
      throw new HttpError(400, "invalid_decision", 'decision must be "approve" or "deny"');
    }
    decideAgentRequest(db, { slug, requestId: id, approve: decision === "approve" });
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
