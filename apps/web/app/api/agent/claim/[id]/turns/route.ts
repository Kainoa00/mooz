import { bearer, requireBridgeAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { askForTurn } from "@/lib/turn-api";

export const dynamic = "force-dynamic";

/** The bridge asks for a turn before it posts or speaks an answer. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    return await askForTurn(req, () => requireBridgeAgent(getDb(), id, bearer(req)));
  } catch (err) {
    return errorResponse(err);
  }
}
