import { requireConnectorAgent } from "@/lib/connector-agents";
import { releaseQuestion } from "@/lib/connector-queue";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { assertSameOrigin } from "@/lib/session";

/**
 * The owner tapped Ask, Copy or Paste for this question: only now may their assistant read
 * it. This is what makes the tap the safeguard, whatever the assistant asks the connector for.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string; qid: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, id, qid } = await ctx.params;
    const agent = requireConnectorAgent(getDb(), req, slug, id);
    releaseQuestion(agent.identity, qid);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
