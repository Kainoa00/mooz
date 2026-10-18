import { hostCookie, sessionCookie } from "@/lib/cookies";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { createRoom } from "@/lib/rooms";

export async function POST(req: Request): Promise<Response> {
  try {
    const { slug, hostSecret } = createRoom(getDb());
    const res = Response.json({ slug }, { status: 201 });
    res.headers.append("set-cookie", sessionCookie(req, hostCookie(slug), hostSecret));
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
