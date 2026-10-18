import { getDb } from "@/lib/db";
import { errorResponse, HttpError, readJson } from "@/lib/http";
import { setParticipantAttributes } from "@/lib/livekit";
import { NOTES_OPT_OUT_ATTRIBUTE, setNotesOptOut } from "@/lib/notes";
import { assertSameOrigin, requireParticipant, requireRoom } from "@/lib/session";

/** Leave yourself out of (or back into) agents' meeting notes. Only ever changes the caller. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug } = await ctx.params;
    const db = getDb();
    const room = requireRoom(db, slug);
    const me = requireParticipant(db, req, slug);
    const { optOut } = await readJson(req);
    if (typeof optOut !== "boolean") throw new HttpError(400, "invalid_body", "optOut must be true or false");
    setNotesOptOut(db, me.identity, optOut);
    // An empty value removes the attribute.
    await setParticipantAttributes(room.livekitRoom, me.identity, {
      [NOTES_OPT_OUT_ATTRIBUTE]: optOut ? "1" : "",
    });
    return Response.json({ optOut });
  } catch (err) {
    return errorResponse(err);
  }
}
