import { requireConnectorAgent } from "@/lib/connector-agents";
import { dismissQuestion } from "@/lib/connector-queue";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { assertSameOrigin } from "@/lib/session";

/** The owner dismisses a question: it's gone, and their assistant can never read it. */
export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string; id: string; qid: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, id, qid } = await ctx.params;
    const agent = requireConnectorAgent(getDb(), req, slug, id);
    dismissQuestion(agent.identity, qid);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
