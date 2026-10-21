import { requestConnectorJoin } from "@/lib/connector-agents";
import { requireOwnerKey } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { HttpError, errorResponse, readJson, SMALL_JSON_BYTES } from "@/lib/http";
import { removeAllFromRooms } from "@/lib/kicks";
import { allow } from "@/lib/rate-limit";
import { assertSameOrigin, requireParticipant } from "@/lib/session";

/** Bringing a connector in is a few clicks a meeting; more is a script keeping links alive. */
export const BRINGS_PER_MINUTE = 10;
export const ROOM_BRINGS_PER_MINUTE = 30;

/** The owner brings their connector into this meeting; the host then approves it. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug } = await ctx.params;
    const db = getDb();
    const owner = requireParticipant(db, req, slug);
    if (
      !allow(`connector-brings:${owner.identity}`, BRINGS_PER_MINUTE, 60_000) ||
      !allow(`connector-brings-room:${slug}`, ROOM_BRINGS_PER_MINUTE, 60_000)
    ) {
      throw new HttpError(429, "rate_limited", "Too many requests to bring agents in just now. Try again in a minute.");
    }
    const body = await readJson(req, SMALL_JSON_BYTES);
    const { requestId, status, superseded } = requestConnectorJoin(db, owner, requireOwnerKey(req), body.connectorId);
    await removeAllFromRooms(superseded);
    return Response.json({ requestId, status }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
