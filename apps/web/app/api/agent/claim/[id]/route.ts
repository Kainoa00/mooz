import { getClaimStatus } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { livekitConfig, mintAgentToken } from "@/lib/livekit";

export const dynamic = "force-dynamic";

function bearer(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

/** Polled by the bridge until the host decides; returns the agent's token once approved. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const claim = getClaimStatus(getDb(), id, bearer(req));
    if (claim.status !== "approved") return Response.json({ status: claim.status });
    return Response.json({
      status: "approved",
      token: await mintAgentToken(claim.agent),
      url: livekitConfig().url,
      room: claim.agent.slug,
      identity: claim.agent.identity,
      name: claim.agent.name,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
