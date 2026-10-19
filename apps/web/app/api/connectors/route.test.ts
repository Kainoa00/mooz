import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_COOKIE_HTTPS as OWNER_COOKIE, findConnectorBySecret } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { jsonRequest, setCookies, useTestEnv } from "@/test/helpers";
import { GET, POST } from "./route";

beforeEach(useTestEnv);

const URL_BASE = "https://meet.example.org/api/connectors";

async function create(body: unknown, cookie?: string): Promise<Response> {
  return POST(jsonRequest(URL_BASE, body, cookie ? { cookie: `${OWNER_COOKIE}=${cookie}` } : {}));
}

describe("/api/connectors", () => {
  it("creates a connector, shows its URL once, and remembers this browser as its owner", async () => {
    const res = await create({ name: "Grok", app: "grok" });

    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { connector: { id: string; name: string }; url: string };
    expect(body.connector.name).toBe("Grok");
    expect(body.url).toMatch(/^https:\/\/meet\.example\.org\/mcp\/[A-Za-z0-9_-]{43}$/);
    expect(findConnectorBySecret(getDb(), body.url.split("/").pop()!)?.id).toBe(body.connector.id);

    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${OWNER_COOKIE}=`))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=31536000");
    expect(cookie).toContain("Secure");
  });

  it("lists only this browser's connectors, never their URLs", async () => {
    const first = await create({ name: "Grok", app: "grok" });
    const owner = setCookies(first)[OWNER_COOKIE];
    const second = await create({ name: "Claude", app: "claude" }, owner);
    expect(setCookies(second)[OWNER_COOKIE]).toBeUndefined(); // already known
    await create({ name: "Grok", app: "grok" }); // someone else's

    const res = await GET(new Request(URL_BASE, { headers: { cookie: `${OWNER_COOKIE}=${owner}` } }));
    const body = (await res.json()) as { connectors: { name: string }[] };
    expect(body.connectors.map((c) => c.name).sort()).toEqual(["Claude", "Grok"]);
    expect(JSON.stringify(body)).not.toContain("/mcp/");
  });

  it("lists nothing for a browser without connectors", async () => {
    const res = await GET(new Request(URL_BASE));
    expect(await res.json()).toEqual({ connectors: [] });
  });

  it("refuses cross-site requests and bad input", async () => {
    const crossSite = await POST(
      jsonRequest(URL_BASE, { name: "Grok", app: "grok" }, { "sec-fetch-site": "cross-site" }),
    );
    expect(crossSite.status).toBe(403);
    expect((await create({ name: "Grok", app: "gemini" })).status).toBe(400);
  });
});
