import {
  OWNER_COOKIE_MAX_AGE,
  connectorUrl,
  createConnector,
  listConnectors,
  ownerCookieName,
  readOwnerKey,
} from "@/lib/connectors";
import { pruneConnectors } from "@/lib/connector-agents";
import { sessionCookie } from "@/lib/cookies";
import { getDb } from "@/lib/db";
import { envInt } from "@/lib/env";
import { HttpError, errorResponse, readJson } from "@/lib/http";
import { newSecret } from "@/lib/ids";
import { allow } from "@/lib/rate-limit";
import { assertSameOrigin, publicOrigin, requireParticipant } from "@/lib/session";

/** New connectors a minute, across this server (MOOZ_CONNECTORS_PER_MINUTE changes it). */
export const CREATES_PER_MINUTE = envInt("MOOZ_CONNECTORS_PER_MINUTE", 60);
/** And an hour per person in a meeting, so one person can't spend everyone's minute. */
export const CREATES_PER_PERSON_PER_HOUR = 10;

/** This browser's connectors (never their links: those are shown only once). */
export async function GET(req: Request): Promise<Response> {
  try {
    const owner = readOwnerKey(req);
    const connectors = owner ? listConnectors(getDb(), owner) : [];
    return Response.json({ connectors }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Create a connector, from a meeting you're in; the first one makes this browser an owner. */
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const body = await readJson(req);
    const db = getDb();
    if (typeof body.slug !== "string") throw new HttpError(400, "invalid_body", "Make a connector from a meeting");
    const me = requireParticipant(db, req, body.slug);
    if (!allow(`connectors-by:${me.identity}`, CREATES_PER_PERSON_PER_HOUR, 60 * 60_000)) {
      throw new HttpError(429, "rate_limited", "You've made a lot of connectors just now. Try again later.");
    }
    if (!allow("connectors:create", CREATES_PER_MINUTE, 60_000)) {
      throw new HttpError(429, "rate_limited", "Too many new connectors on this server just now. Try again in a minute.");
    }
    const known = readOwnerKey(req);
    const owner = known ?? newSecret();
    pruneConnectors(db); // room for this one, if abandoned links held it
    const { connector, secret } = createConnector(db, owner, { name: body.name, app: body.app });
    const headers = new Headers({ "cache-control": "no-store" });
    if (!known) headers.append("set-cookie", sessionCookie(req, ownerCookieName(req), owner, OWNER_COOKIE_MAX_AGE));
    return Response.json({ connector, url: connectorUrl(publicOrigin(req), secret) }, { status: 201, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
