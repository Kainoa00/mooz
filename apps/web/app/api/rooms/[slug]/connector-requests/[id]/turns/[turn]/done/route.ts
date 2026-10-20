import { requireConnectorAgent } from "@/lib/connector-agents";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { assertSameOrigin } from "@/lib/session";
import { finishTurn } from "@/lib/turn-api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; id: string; turn: string }> };

/** The owner's tab is done with its agent's turn. */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, id, turn } = await ctx.params;
    return finishTurn(requireConnectorAgent(getDb(), req, slug, id), turn);
  } catch (err) {
    return errorResponse(err);
  }
}
