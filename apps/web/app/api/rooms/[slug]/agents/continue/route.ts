import { getDb } from "@/lib/db";
import { continueAgents } from "@/lib/floor";
import { errorResponse, HttpError } from "@/lib/http";
import { allow } from "@/lib/rate-limit";
import "@/lib/room-state"; // tells the meeting when the floor changes
import { assertSameOrigin, requireParticipant } from "@/lib/session";

export const dynamic = "force-dynamic";

export const CONTINUES_PER_MINUTE = 10;

/**
 * Anyone in the meeting (a person: agents have no participant cookie) lets agents that were
 * paused after going back and forth carry on. The held reply goes out.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug } = await ctx.params;
    const person = requireParticipant(getDb(), req, slug);
    if (!allow(`continue:${person.identity}`, CONTINUES_PER_MINUTE, 60_000)) {
      throw new HttpError(429, "rate_limited", "Too many clicks just now");
    }
    return Response.json({ released: continueAgents(slug) });
  } catch (err) {
    return errorResponse(err);
  }
}
