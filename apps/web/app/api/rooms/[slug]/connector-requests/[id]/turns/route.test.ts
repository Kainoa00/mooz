import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideAgentRequest } from "@/lib/agents";
import { connectorAgentFor, requestConnectorJoin } from "@/lib/connector-agents";
import { OWNER_COOKIE, createConnector } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { floorView, resetFloorsForTests } from "@/lib/floor";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { addParticipant, createRoom } from "@/lib/rooms";
import type { TurnJson } from "@/lib/turn-api";
import { jsonRequest, params, useTestEnv } from "@/test/helpers";

vi.mock("@/lib/livekit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/livekit")>()),
  setRoomMetadata: async () => {},
  removeFromRoom: async () => {},
}));

const { POST: ASK } = await import("./route");
const { GET: CHECK } = await import("./[turn]/route");
const { POST: DONE } = await import("./[turn]/done/route");
const { DELETE: WITHDRAW } = await import("../route");

beforeEach(() => {
  useTestEnv();
  resetFloorsForTests();
  resetRateLimitsForTests();
});

function setup() {
  const db = getDb();
  const { slug } = createRoom(db);
  const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
  const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
  const { connector } = createConnector(db, "kai-key", { name: "Grok", app: "grok" });
  const { requestId } = requestConnectorJoin(db, kai, "kai-key", connector.id);
  decideAgentRequest(db, { slug, requestId, approve: true });
  const agent = connectorAgentFor(db, kai, "kai-key", requestId);
  const cookie = `mooz_p_${slug}=${kai.secret}; ${OWNER_COOKIE}=kai-key`;
  const url = `http://localhost/api/rooms/${slug}/connector-requests/${requestId}`;
  return { db, slug, kai, zach, requestId, agent, cookie, url };
}

const turnOf = async (res: Response) => ((await res.json()) as { turn: TurnJson }).turn;

describe("connector turns", () => {
  it("takes a turn for its owner's tab, then gives it back", async () => {
    const { slug, requestId, agent, cookie, url } = setup();
    const asked = await ASK(jsonRequest(`${url}/turns`, { answering: "person", speak: true }, { cookie }), params({ slug, id: requestId }));
    expect(asked.status).toBe(201);
    const turn = await turnOf(asked);
    expect(turn.status).toBe("granted");
    expect(floorView(slug).speaking).toBe(agent.identity);

    const checked = await CHECK(new Request(`${url}/turns/${turn.id}`, { headers: { cookie } }), params({ slug, id: requestId, turn: turn.id }));
    expect(await turnOf(checked)).toMatchObject({ status: "granted" });

    const ended = await DONE(
      new Request(`${url}/turns/${turn.id}/done`, { method: "POST", headers: { cookie } }),
      params({ slug, id: requestId, turn: turn.id }),
    );
    expect(await turnOf(ended)).toMatchObject({ status: "ended", reason: "done" });
    expect(floorView(slug).speaking).toBeNull();
  });

  it("is only for the agent's owner, from this site", async () => {
    const { slug, zach, requestId, cookie, url } = setup();
    const body = { answering: "person", speak: true };
    const notOwner = await ASK(jsonRequest(`${url}/turns`, body, { cookie: `mooz_p_${slug}=${zach.secret}; ${OWNER_COOKIE}=zach-key` }), params({ slug, id: requestId }));
    expect(notOwner.status).toBe(404);
    const crossSite = await ASK(jsonRequest(`${url}/turns`, body, { cookie, "sec-fetch-site": "cross-site" }), params({ slug, id: requestId }));
    expect(crossSite.status).toBe(403);
    const crossSiteDone = await DONE(
      new Request(`${url}/turns/t_x/done`, { method: "POST", headers: { cookie, "sec-fetch-site": "cross-site" } }),
      params({ slug, id: requestId, turn: "t_x" }),
    );
    expect(crossSiteDone.status).toBe(403);
    const noCookie = await CHECK(new Request(`${url}/turns/t_x`), params({ slug, id: requestId, turn: "t_x" }));
    expect(noCookie.status).toBe(401);
  });

  it("gives up the floor when the owner takes the agent out", async () => {
    const { slug, requestId, cookie, url } = setup();
    await ASK(jsonRequest(`${url}/turns`, { answering: "person", speak: true }, { cookie }), params({ slug, id: requestId }));
    await WITHDRAW(new Request(url, { method: "DELETE", headers: { cookie } }), params({ slug, id: requestId }));
    expect(floorView(slug).speaking).toBeNull();
  });
});
