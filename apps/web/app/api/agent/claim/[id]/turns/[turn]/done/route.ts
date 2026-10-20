import { bearer, requireBridgeAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { finishTurn } from "@/lib/turn-api";

export const dynamic = "force-dynamic";

/** The bridge is done with its turn (or gives up waiting for it). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; turn: string }> }): Promise<Response> {
  try {
    const { id, turn } = await ctx.params;
    return finishTurn(requireBridgeAgent(getDb(), id, bearer(req)), turn);
  } catch (err) {
    return errorResponse(err);
  }
}
