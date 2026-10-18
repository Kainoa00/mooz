import { getDb } from "@/lib/db";
import { errorResponse, HttpError, readJson } from "@/lib/http";
import { setRoomMetadata } from "@/lib/livekit";
import { notesMetadata, setNotesPolicy } from "@/lib/notes";
import { assertSameOrigin, requireHost } from "@/lib/session";

/** Host-only: allow or stop agents keeping meeting notes in this meeting. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { slug } = await ctx.params;
    const db = getDb();
    const room = requireHost(db, req, slug);
    const { allowed } = await readJson(req);
    if (typeof allowed !== "boolean") throw new HttpError(400, "invalid_body", "allowed must be true or false");
    setNotesPolicy(db, slug, allowed);
    await setRoomMetadata(room.livekitRoom, notesMetadata(allowed));
    return Response.json({ allowed });
  } catch (err) {
    return errorResponse(err);
  }
}
