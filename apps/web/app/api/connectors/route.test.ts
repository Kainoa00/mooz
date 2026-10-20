import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_COOKIE_HTTPS as OWNER_COOKIE, findConnectorBySecret } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { addParticipant, createRoom } from "@/lib/rooms";
import { AGENT_NAMES as NAMES, jsonRequest, setCookies, useTestEnv } from "@/test/helpers";
import { CREATES_PER_MINUTE, CREATES_PER_PERSON_PER_HOUR, GET, POST } from "./route";

let inMeeting: { slug: string; cookie: string };
beforeEach(() => {
  useTestEnv();
  resetRateLimitsForTests();
  const { slug } = createRoom(getDb());
  const kai = addParticipant(getDb(), { slug, name: "Kainoa", isHost: true });
  inMeeting = { slug, cookie: `mooz_p_${slug}=${kai.secret}` };
});

const URL_BASE = "https://meet.example.org/api/connectors";

/** Made from a meeting the caller is in, as the dialog does. */
async function create(body: Record<string, unknown>, cookie?: string): Promise<Response> {
  const cookies = [inMeeting.cookie, ...(cookie ? [`${OWNER_COOKIE}=${cookie}`] : [])].join("; ");
  return POST(jsonRequest(URL_BASE, { slug: inMeeting.slug, ...body }, { cookie: cookies }));
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

  it("is only for someone in a meeting, and not too many at once across the server", async () => {
    const outside = await POST(jsonRequest(URL_BASE, { name: "Grok", app: "grok" }));
    expect(outside.status).toBe(400);
    const notIn = await POST(jsonRequest(URL_BASE, { name: "Grok", app: "grok", slug: inMeeting.slug }));
    expect(notIn.status).toBe(401);

    // One person can make only so many…
    const mine: number[] = [];
    for (let i = 0; i <= CREATES_PER_PERSON_PER_HOUR; i++) mine.push((await create({ name: `Grok ${NAMES[i]}`, app: "grok" })).status);
    expect(mine.slice(0, CREATES_PER_PERSON_PER_HOUR).every((s) => s === 201)).toBe(true);
    expect(mine.at(-1)).toBe(429);

    // …and the whole server only so many a minute.
    resetRateLimitsForTests();
    const all: number[] = [];
    for (let i = 0; i <= CREATES_PER_MINUTE; i++) {
      const someone = addParticipant(getDb(), { slug: inMeeting.slug, name: `P${i}`, isHost: false });
      const res = await POST(
        jsonRequest(URL_BASE, { slug: inMeeting.slug, name: "Grok", app: "grok" }, { cookie: `mooz_p_${inMeeting.slug}=${someone.secret}` }),
      );
      all.push(res.status);
    }
    expect(all.slice(0, CREATES_PER_MINUTE).every((s) => s === 201)).toBe(true);
    expect(all.at(-1)).toBe(429);
  });
});
