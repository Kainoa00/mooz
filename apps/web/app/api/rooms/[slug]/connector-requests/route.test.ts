import { TokenVerifier } from "livekit-server-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideAgentRequest, isRevokedAgent } from "@/lib/agents";
import { connectorAgentFor } from "@/lib/connector-agents";
import { OWNER_COOKIE, createConnector } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { addParticipant, createRoom, getRoom } from "@/lib/rooms";
import { LK_KEY, LK_SECRET, jsonRequest, params, useTestEnv } from "@/test/helpers";

const removeFromRoom = vi.fn<(room: string, identity: string) => Promise<void>>(async () => {});
vi.mock("@/lib/livekit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/livekit")>()),
  removeFromRoom: (room: string, identity: string) => removeFromRoom(room, identity),
}));

const { BRINGS_PER_MINUTE, POST: REQUEST } = await import("./route");
const { GET: STATUS } = await import("./[id]/route");
const { POST: TOKEN } = await import("./[id]/token/route");
const { DELETE: DELETE_CONNECTOR } = await import("@/app/api/connectors/[id]/route");

beforeEach(() => {
  useTestEnv();
  resetRateLimitsForTests();
  removeFromRoom.mockClear();
});

const KAI_KEY = "owner-key-kai";

function setup() {
  const db = getDb();
  const { slug } = createRoom(db);
  const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
  const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
  const { connector } = createConnector(db, KAI_KEY, { name: "Grok", app: "grok" });
  const cookie = `mooz_p_${slug}=${kai.secret}; ${OWNER_COOKIE}=${KAI_KEY}`;
  return { db, slug, kai, zach, connector, cookie };
}

const base = (slug: string) => `http://localhost/api/rooms/${slug}/connector-requests`;

describe("/api/rooms/[slug]/connector-requests", () => {
  it("takes only a few bring requests a minute (a script re-bringing links can't keep them alive)", async () => {
    const { slug, connector, cookie } = setup();
    const statuses: number[] = [];
    for (let i = 0; i <= BRINGS_PER_MINUTE; i++) {
      statuses.push((await REQUEST(jsonRequest(base(slug), { connectorId: connector.id }, { cookie }), params({ slug }))).status);
    }
    expect(statuses.slice(0, BRINGS_PER_MINUTE).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("brings the owner's connector: pending, then approved, then a token for the owner's tab", async () => {
    const { db, slug, kai, connector, cookie } = setup();

    const res = await REQUEST(jsonRequest(base(slug), { connectorId: connector.id }, { cookie }), params({ slug }));
    expect(res.status).toBe(201);
    const { requestId } = (await res.json()) as { requestId: string };

    const status = () =>
      STATUS(new Request(`${base(slug)}/${requestId}`, { headers: { cookie } }), params({ slug, id: requestId }));
    expect(await (await status()).json()).toEqual({ status: "pending" });
    const early = await TOKEN(
      new Request(`${base(slug)}/${requestId}/token`, { method: "POST", headers: { cookie } }),
      params({ slug, id: requestId }),
    );
    expect(early.status).toBe(409);

    decideAgentRequest(db, { slug, requestId, approve: true });
    expect(await (await status()).json()).toEqual({ status: "approved" });

    const tokenRes = await TOKEN(
      new Request(`${base(slug)}/${requestId}/token`, { method: "POST", headers: { cookie } }),
      params({ slug, id: requestId }),
    );
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    const body = (await tokenRes.json()) as { token: string; url: string; identity: string; name: string };
    expect(body).toMatchObject({ url: "ws://livekit.test:7880", name: "Grok" });
    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(body.token);
    expect(claims.sub).toBe(body.identity);
    expect(claims.attributes).toEqual({
      kind: "agent",
      door: "connector",
      connector_app: "grok",
      owner_id: kai.identity,
      owner_name: "Kainoa",
    });
    expect(claims.video).toMatchObject({
      room: getRoom(db, slug)!.livekitRoom,
      canPublishSources: ["microphone"],
      canUpdateOwnMetadata: false,
    });
  });

  it("is the owner's alone: other people, and other browsers, can't bring or use it", async () => {
    const { db, slug, zach, connector, cookie } = setup();
    const zachCookie = `mooz_p_${slug}=${zach.secret}; ${OWNER_COOKIE}=zach-key`;
    const notTheirs = await REQUEST(
      jsonRequest(base(slug), { connectorId: connector.id }, { cookie: zachCookie }),
      params({ slug }),
    );
    expect(notTheirs.status).toBe(404);

    const { requestId } = (await (
      await REQUEST(jsonRequest(base(slug), { connectorId: connector.id }, { cookie }), params({ slug }))
    ).json()) as { requestId: string };
    decideAgentRequest(db, { slug, requestId, approve: true });
    const stolen = await TOKEN(
      new Request(`${base(slug)}/${requestId}/token`, { method: "POST", headers: { cookie: zachCookie } }),
      params({ slug, id: requestId }),
    );
    expect(stolen.status).toBe(404);
  });

  it("needs the owner to be in the meeting and to ask from it", async () => {
    const { slug, connector } = setup();
    const res = await REQUEST(
      jsonRequest(base(slug), { connectorId: connector.id }, { cookie: `${OWNER_COOKIE}=${KAI_KEY}` }),
      params({ slug }),
    );
    expect(res.status).toBe(401);
    const crossSite = await REQUEST(
      jsonRequest(base(slug), { connectorId: connector.id }, { "sec-fetch-site": "cross-site" }),
      params({ slug }),
    );
    expect(crossSite.status).toBe(403);
  });

  it("takes the connector out of the meeting it was in", async () => {
    const { db, slug, kai, connector, cookie } = setup();
    const first = (await (
      await REQUEST(jsonRequest(base(slug), { connectorId: connector.id }, { cookie }), params({ slug }))
    ).json()) as { requestId: string };
    decideAgentRequest(db, { slug, requestId: first.requestId, approve: true });
    const agent = connectorAgentFor(db, kai, KAI_KEY, first.requestId);

    const { slug: other } = createRoom(db);
    const kaiThere = addParticipant(db, { slug: other, name: "Kainoa", isHost: false });
    const res = await REQUEST(
      jsonRequest(base(other), { connectorId: connector.id }, {
        cookie: `mooz_p_${other}=${kaiThere.secret}; ${OWNER_COOKIE}=${KAI_KEY}`,
      }),
      params({ slug: other }),
    );

    expect(res.status).toBe(201);
    expect(removeFromRoom).toHaveBeenCalledWith(getRoom(db, slug)!.livekitRoom, agent.identity);
  });

  it("still joins if disconnecting the old agent fails (it can't rejoin anyway)", async () => {
    const { db, slug, kai, connector, cookie } = setup();
    const first = (await (
      await REQUEST(jsonRequest(base(slug), { connectorId: connector.id }, { cookie }), params({ slug }))
    ).json()) as { requestId: string };
    decideAgentRequest(db, { slug, requestId: first.requestId, approve: true });
    const agent = connectorAgentFor(db, kai, KAI_KEY, first.requestId);
    removeFromRoom.mockRejectedValueOnce(new Error("livekit unreachable"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const again = await REQUEST(jsonRequest(base(slug), { connectorId: connector.id }, { cookie }), params({ slug }));

    expect(again.status).toBe(201);
    expect(isRevokedAgent(db, agent.identity)).toBe(true);
    errors.mockRestore();
  });

  it("removes the agent from its meeting when the connector is deleted", async () => {
    const { db, slug, kai, connector, cookie } = setup();
    const { requestId } = (await (
      await REQUEST(jsonRequest(base(slug), { connectorId: connector.id }, { cookie }), params({ slug }))
    ).json()) as { requestId: string };
    decideAgentRequest(db, { slug, requestId, approve: true });
    const agent = connectorAgentFor(db, kai, KAI_KEY, requestId);

    const res = await DELETE_CONNECTOR(
      new Request(`http://localhost/api/connectors/${connector.id}`, {
        method: "DELETE",
        headers: { cookie: `${OWNER_COOKIE}=${KAI_KEY}` },
      }),
      params({ id: connector.id }),
    );

    expect(res.status).toBe(200);
    expect(isRevokedAgent(db, agent.identity)).toBe(true);
    expect(removeFromRoom).toHaveBeenCalledWith(getRoom(db, slug)!.livekitRoom, agent.identity);
  });
});
