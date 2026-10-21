import { maybeSweep } from "@/lib/cleanup";
import { hostCookie, sessionCookie } from "@/lib/cookies";
import { getDb } from "@/lib/db";
import { envInt } from "@/lib/env";
import { HttpError, errorResponse } from "@/lib/http";
import { allow } from "@/lib/rate-limit";
import { createRoom } from "@/lib/rooms";
import { assertSameOrigin } from "@/lib/session";

/** New meetings a minute, across this server (MOOZ_ROOMS_PER_MINUTE changes it). */
export const ROOMS_PER_MINUTE = envInt("MOOZ_ROOMS_PER_MINUTE", 30);

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    if (!allow("rooms:create", ROOMS_PER_MINUTE, 60_000)) {
      throw new HttpError(429, "rate_limited", "Lots of meetings are starting just now. Try again in a minute.");
    }
    const db = getDb();
    maybeSweep(db);
    const { slug, hostSecret } = createRoom(db);
    const res = Response.json({ slug }, { status: 201 });
    res.headers.append("set-cookie", sessionCookie(req, hostCookie(slug), hostSecret));
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
