import {
  OWNER_COOKIE_MAX_AGE,
  connectorUrl,
  createConnector,
  listConnectors,
  ownerCookieName,
  readOwnerKey,
} from "@/lib/connectors";
import { sessionCookie } from "@/lib/cookies";
import { getDb } from "@/lib/db";
import { errorResponse, readJson } from "@/lib/http";
import { newSecret } from "@/lib/ids";
import { assertSameOrigin, publicOrigin } from "@/lib/session";

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

/** Create a connector; the first one makes this browser an owner. */
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const body = await readJson(req);
    const known = readOwnerKey(req);
    const owner = known ?? newSecret();
    const { connector, secret } = createConnector(getDb(), owner, { name: body.name, app: body.app });
    const headers = new Headers({ "cache-control": "no-store" });
    if (!known) headers.append("set-cookie", sessionCookie(req, ownerCookieName(req), owner, OWNER_COOKIE_MAX_AGE));
    return Response.json({ connector, url: connectorUrl(publicOrigin(req), secret) }, { status: 201, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
