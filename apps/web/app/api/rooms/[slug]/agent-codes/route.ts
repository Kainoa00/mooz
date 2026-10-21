import { createAgentCode } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { errorResponse, HttpError } from "@/lib/http";
import { allow } from "@/lib/rate-limit";
import { assertSameOrigin, publicOrigin, requireParticipant } from "@/lib/session";

/** Each code may try a few names; more codes than this an hour is someone probing who's here. */
export const CODES_PER_PERSON_PER_HOUR = 10;
/** And per meeting, since joining again makes a new person with a fresh count. */
export const CODES_PER_MEETING_PER_HOUR = 50;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug } = await ctx.params;
    const db = getDb();
    const owner = requireParticipant(db, req, slug);
    if (
      !allow(`agent-codes:${owner.identity}`, CODES_PER_PERSON_PER_HOUR, 60 * 60 * 1000) ||
      !allow(`agent-codes-room:${slug}`, CODES_PER_MEETING_PER_HOUR, 60 * 60 * 1000)
    ) {
      throw new HttpError(429, "rate_limited", "That's a lot of agent codes: try again in a while");
    }
    const { code, expiresAt } = createAgentCode(db, owner);
    const command = `mooz-agent connect ${code} --server ${publicOrigin(req)}`;
    return Response.json({ code, command, expiresAt }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
