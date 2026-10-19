import { requireConnectorAgent } from "@/lib/connector-agents";
import { enqueueQuestion, listQuestions } from "@/lib/connector-queue";
import { getDb } from "@/lib/db";
import { HttpError, errorResponse, readJson } from "@/lib/http";
import { allow } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; id: string }> };

/** More than this in a minute is someone spamming the agent (each costs its owner). */
export const QUESTIONS_PER_MINUTE = 20;
/** And across all of a meeting's connector agents, so many agents can't add up to a flood. */
export const ROOM_QUESTIONS_PER_MINUTE = 60;

/** The owner's tab heard someone address its agent: queue the question for the assistant. */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, id } = await ctx.params;
    const db = getDb();
    const agent = requireConnectorAgent(db, req, slug, id);
    if (
      !allow(`questions:${agent.identity}`, QUESTIONS_PER_MINUTE, 60_000) ||
      !allow(`questions-room:${agent.slug}`, ROOM_QUESTIONS_PER_MINUTE, 60_000)
    ) {
      throw new HttpError(429, "rate_limited", "Too many questions for your agent just now");
    }
    const body = await readJson(req);
    const question = enqueueQuestion(db, agent, { asker: body.asker, text: body.text, lines: body.lines, at: body.at });
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
