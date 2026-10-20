import { requireConnectorAgent } from "@/lib/connector-agents";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { assertSameOrigin } from "@/lib/session";
import { askForTurn } from "@/lib/turn-api";

export const dynamic = "force-dynamic";

/** The owner's tab asks for a turn before its agent posts or speaks. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug, id } = await ctx.params;
    return await askForTurn(req, () => requireConnectorAgent(getDb(), req, slug, id));
  } catch (err) {
    return errorResponse(err);
  }
}
