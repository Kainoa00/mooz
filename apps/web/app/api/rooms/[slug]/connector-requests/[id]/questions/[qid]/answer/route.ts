import { requireConnectorAgent } from "@/lib/connector-agents";
import { deliverAnswer } from "@/lib/connector-delivery";
import { answerQuestion } from "@/lib/connector-queue";
import { getDb } from "@/lib/db";
import { errorResponse, readJson } from "@/lib/http";
import { assertSameOrigin } from "@/lib/session";

/** The owner pastes their assistant's answer (for apps whose connectors can't write). */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string; qid: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, id, qid } = await ctx.params;
    const agent = requireConnectorAgent(getDb(), req, slug, id);
    const body = await readJson(req);
    const packet = answerQuestion(agent.identity, qid, { spoken: body.spoken, details: body.details }, { by: "owner" });
    return Response.json({ ok: true, delivered: await deliverAnswer(agent, packet) });
  } catch (err) {
    return errorResponse(err);
  }
}
