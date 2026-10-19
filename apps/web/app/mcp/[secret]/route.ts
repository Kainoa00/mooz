import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { attachedConnectorAgent } from "@/lib/connector-agents";
import { findConnectorBySecret, touchConnector } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { readCapped } from "@/lib/http";
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

async function handle(req: Request, ctx: { params: Promise<{ secret: string }> }): Promise<Response> {
  const { secret } = await ctx.params;
  const db = getDb();
  const connector = findConnectorBySecret(db, secret);
  if (!connector) return notFound();
  // Stateless: there's no stream to open (GET) or session to end (DELETE). Saying so with a
  // 405 stops clients from reopening a stream that closes at once, every second.
  if (req.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { status: 405, headers: { allow: "POST" } },
    );
  }
  if (!allow(`mcp:${connector.id}`, REQUESTS_PER_MINUTE, 60_000)) {
    return Response.json({ error: { code: "rate_limited", message: "Too many requests" } }, { status: 429 });
  }
  // "Used" means used in a meeting: calling a link nobody brought into one doesn't keep it
  // from expiring (so a flood of links can't be kept alive by pinging them).
  if (attachedConnectorAgent(db, connector.id)) touchConnector(db, connector);
  const body = await readCapped(req, MAX_BODY_BYTES);
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
    const forwarded = new Request(req.url, { method: "POST", headers: req.headers, body: body || undefined });
    return await transport.handleRequest(forwarded);
  } finally {
    await server.close();
  }
}

export { handle as DELETE, handle as GET, handle as POST };
