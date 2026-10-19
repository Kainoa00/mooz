import { requireConnectorAgent } from "@/lib/connector-agents";
import { enqueueQuestion, listQuestions } from "@/lib/connector-queue";
import { getDb } from "@/lib/db";
import { errorResponse, readJson } from "@/lib/http";
import { assertSameOrigin } from "@/lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; id: string }> };

/** The owner's tab heard someone address its agent: queue the question for the assistant. */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, id } = await ctx.params;
    const db = getDb();
    const agent = requireConnectorAgent(db, req, slug, id);
    const body = await readJson(req);
    const question = enqueueQuestion(db, agent, { asker: body.asker, text: body.text, lines: body.lines });
    return Response.json({ question }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** The agent's questions, so the owner's tab can show what's waiting (also after a reload). */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const { slug, id } = await ctx.params;
    const agent = requireConnectorAgent(getDb(), req, slug, id);
    return Response.json({ questions: listQuestions(agent.identity) }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
