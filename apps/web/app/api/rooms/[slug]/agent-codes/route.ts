import { createAgentCode } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { assertSameOrigin, publicOrigin, requireParticipant } from "@/lib/session";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug } = await ctx.params;
    const db = getDb();
    const owner = requireParticipant(db, req, slug);
    const { code, expiresAt } = createAgentCode(db, owner);
    const command = `mooz-agent connect ${code} --server ${publicOrigin(req)}`;
    return Response.json({ code, command, expiresAt }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
