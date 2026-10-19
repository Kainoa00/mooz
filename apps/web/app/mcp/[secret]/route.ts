import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { findConnectorBySecret } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { mcpServerFor } from "@/lib/mcp";
import { allow } from "@/lib/rate-limit";

/**
 * A connector's private MCP link (Streamable HTTP, stateless). The secret in the path
 * is the whole credential: an unknown or rotated one looks exactly like a missing page,
 * and nothing here ever echoes or logs it.
 */

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const REQUESTS_PER_MINUTE = 30;

const notFound = () => Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });

/** The body as text, or null once it passes `max` bytes (it stops reading there). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function handle(req: Request, ctx: { params: Promise<{ secret: string }> }): Promise<Response> {
  const { secret } = await ctx.params;
  const db = getDb();
  const connector = findConnectorBySecret(db, secret, { touch: true });
  if (!connector) return notFound();
  if (!allow(`mcp:${connector.id}`, REQUESTS_PER_MINUTE, 60_000)) {
    return Response.json({ error: { code: "rate_limited", message: "Too many requests" } }, { status: 429 });
  }
  const body = req.method === "POST" ? await readCapped(req, MAX_BODY_BYTES) : undefined;
  if (body === null) {
    return Response.json({ error: { code: "too_large", message: "Request too large" } }, { status: 413 });
  }
  const server = mcpServerFor(db, connector);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: every request stands alone
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const forwarded = new Request(req.url, { method: req.method, headers: req.headers, body: body || undefined });
    return await transport.handleRequest(forwarded);
  } finally {
    await server.close();
  }
}

export { handle as DELETE, handle as GET, handle as POST };
