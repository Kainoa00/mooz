import { requireConnectorAgent } from "@/lib/connector-agents";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { checkTurn } from "@/lib/turn-api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; id: string; turn: string }> };

/** The owner's tab waits for its agent's turn (each call waits up to 25 s for it to change). */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const { slug, id, turn } = await ctx.params;
    return await checkTurn(requireConnectorAgent(getDb(), req, slug, id), turn, req);
  } catch (err) {
    return errorResponse(err);
  }
}
