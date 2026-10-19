import {
  OWNER_COOKIE,
  OWNER_COOKIE_MAX_AGE,
  connectorUrl,
  createConnector,
  listConnectors,
} from "@/lib/connectors";
import { readCookie, sessionCookie } from "@/lib/cookies";
import { getDb } from "@/lib/db";
import { errorResponse, readJson } from "@/lib/http";
import { newSecret } from "@/lib/ids";
import { assertSameOrigin, publicOrigin } from "@/lib/session";

/** This browser's connectors (never their links: those are shown only once). */
export async function GET(req: Request): Promise<Response> {
  try {
    const owner = readCookie(req, OWNER_COOKIE);
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
    const known = readCookie(req, OWNER_COOKIE);
    const owner = known ?? newSecret();
    const { connector, secret } = createConnector(getDb(), owner, { name: body.name, app: body.app });
    const headers = new Headers({ "cache-control": "no-store" });
    if (!known) headers.append("set-cookie", sessionCookie(req, OWNER_COOKIE, owner, OWNER_COOKIE_MAX_AGE));
    return Response.json({ connector, url: connectorUrl(publicOrigin(req), secret) }, { status: 201, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
