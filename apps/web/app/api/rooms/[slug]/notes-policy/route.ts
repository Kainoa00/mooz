import { getDb } from "@/lib/db";
import { errorResponse, HttpError, readJson, SMALL_JSON_BYTES } from "@/lib/http";
import { setNotesPolicy } from "@/lib/notes";
import { publishRoomState } from "@/lib/room-state";
import { assertSameOrigin, requireHost } from "@/lib/session";

/** Host-only: allow or stop agents keeping meeting notes in this meeting. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug } = await ctx.params;
    const db = getDb();
    const room = requireHost(db, req, slug);
    const { allowed } = await readJson(req, SMALL_JSON_BYTES);
    if (typeof allowed !== "boolean") throw new HttpError(400, "invalid_body", "allowed must be true or false");
    setNotesPolicy(db, slug, allowed);
    await publishRoomState(db, room.slug);
    return Response.json({ allowed });
  } catch (err) {
    return errorResponse(err);
  }
}
