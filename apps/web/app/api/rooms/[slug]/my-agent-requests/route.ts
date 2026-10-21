import { MY_REQUESTS_PER_MINUTE, listMyAgentRequests } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { HttpError, errorResponse } from "@/lib/http";
import { allow } from "@/lib/rate-limit";
import { requireParticipant } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The agents brought with my codes that are waiting for the host or in the meeting. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    const { slug } = await ctx.params;
    const db = getDb();
    const me = requireParticipant(db, req, slug);
    if (!allow(`my-requests:${me.identity}`, MY_REQUESTS_PER_MINUTE, 60_000)) {
      throw new HttpError(429, "rate_limited", "Too many checks just now");
    }
    return Response.json({ requests: listMyAgentRequests(db, me) }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
