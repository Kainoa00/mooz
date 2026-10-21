import { getDb } from "@/lib/db";
import { errorResponse, HttpError, readJson, SMALL_JSON_BYTES } from "@/lib/http";
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
    const { optOut, identity } = await readJson(req, SMALL_JSON_BYTES);
    if (typeof optOut !== "boolean") throw new HttpError(400, "invalid_body", "optOut must be true or false");
    // Tabs in one browser share the cookie. Act only if this tab is the person it names,
    // so a click never changes someone else's choice.
    if (identity !== me.identity) {
      throw new HttpError(409, "stale_session", "You joined from another tab since. Reload this one to rejoin.");
    }
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
