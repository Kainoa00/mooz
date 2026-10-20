import { bearer, requireBridgeAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { checkTurn } from "@/lib/turn-api";

export const dynamic = "force-dynamic";

/** The bridge waits for its turn (each call waits up to 25 s for it to change). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; turn: string }> }): Promise<Response> {
  try {
    const { id, turn } = await ctx.params;
    return await checkTurn(requireBridgeAgent(getDb(), id, bearer(req)), turn, req);
  } catch (err) {
    return errorResponse(err);
  }
}
