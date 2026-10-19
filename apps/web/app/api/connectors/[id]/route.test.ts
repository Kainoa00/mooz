import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_COOKIE, createConnector, findConnectorBySecret } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { params, useTestEnv } from "@/test/helpers";
import { POST as ROTATE } from "./rotate/route";
import { DELETE } from "./route";

beforeEach(useTestEnv);

const KAI = "owner-key-kai";

function request(method: string, path: string, owner?: string, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { ...extra };
  if (owner) headers.cookie = `${OWNER_COOKIE}=${owner}`;
  return new Request(`https://meet.example.org/api/connectors/${path}`, { method, headers });
}

describe("/api/connectors/[id]", () => {
  it("rotates a connector: a new URL, and the old one is dead", async () => {
    const db = getDb();
    const { connector, secret } = createConnector(db, KAI, { name: "Grok", app: "grok" });

    const res = await ROTATE(request("POST", `${connector.id}/rotate`, KAI), params({ id: connector.id }));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { url: string };
    expect(findConnectorBySecret(db, secret)).toBeUndefined();
    expect(findConnectorBySecret(db, body.url.split("/").pop()!)?.id).toBe(connector.id);
  });

  it("deletes a connector", async () => {
    const db = getDb();
    const { connector, secret } = createConnector(db, KAI, { name: "Grok", app: "grok" });

    const res = await DELETE(request("DELETE", connector.id, KAI), params({ id: connector.id }));

    expect(res.status).toBe(200);
    expect(findConnectorBySecret(db, secret)).toBeUndefined();
  });

  it("looks the same as a missing connector to anyone but its owner", async () => {
    const db = getDb();
    const { connector } = createConnector(db, KAI, { name: "Grok", app: "grok" });

    for (const owner of [undefined, "someone-else"]) {
      const rotate = await ROTATE(request("POST", `${connector.id}/rotate`, owner), params({ id: connector.id }));
      const remove = await DELETE(request("DELETE", connector.id, owner), params({ id: connector.id }));
      expect([rotate.status, remove.status]).toEqual([404, 404]);
    }
  });

  it("refuses cross-site requests", async () => {
    const { connector } = createConnector(getDb(), KAI, { name: "Grok", app: "grok" });
    const res = await DELETE(
      request("DELETE", connector.id, KAI, { "sec-fetch-site": "cross-site" }),
      params({ id: connector.id }),
    );
    expect(res.status).toBe(403);
  });
});
