import { beforeEach, describe, expect, it } from "vitest";
import { PENDING_TTL_MS, decideAgentRequest, isRevokedAgent, listPendingRequests, revokeAgent } from "./agents";
import {
  LEFT_GRACE_MS,
  UNJOINED_APPROVAL_MS,
  attachedConnectorAgent,
  connectorAgentFor,
  connectorInUse,
  connectorJoinStatus,
  noteConnectorPresence,
  pruneConnectors,
  requestConnectorJoin,
  revokeConnectorAgents,
} from "./connector-agents";
import { IDLE_LINK_TTL_MS, UNUSED_LINK_TTL_MS, createConnector, listConnectors } from "./connectors";
import { getDb } from "./db";
import { HttpError } from "./http";
import { addParticipant, createRoom, getRoom } from "./rooms";
import { useTestEnv } from "@/test/helpers";

beforeEach(useTestEnv);

const KAI_KEY = "owner-key-kai";

function meeting() {
  const db = getDb();
  const { slug } = createRoom(db);
  const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
  const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
  const { connector } = createConnector(db, KAI_KEY, { name: "Grok", app: "grok" });
  return { db, slug, kai, zach, connector };
}

describe("a connector joining a meeting", () => {
  it("waits for the host, then becomes the owner's agent in that meeting", () => {
    const { db, slug, kai, connector } = meeting();

    const { requestId } = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    expect(connectorJoinStatus(db, kai, KAI_KEY, requestId)).toBe("pending");
    expect(listPendingRequests(db, slug)).toEqual([
      expect.objectContaining({ id: requestId, agentName: "Grok", ownerName: "Kainoa", door: "connector" }),
    ]);
    expect(() => connectorAgentFor(db, kai, KAI_KEY, requestId)).toThrow("not approved");

    decideAgentRequest(db, { slug, requestId, approve: true });

    expect(connectorJoinStatus(db, kai, KAI_KEY, requestId)).toBe("approved");
    const agent = connectorAgentFor(db, kai, KAI_KEY, requestId);
    expect(agent).toMatchObject({
      name: "Grok",
      ownerIdentity: kai.identity,
      ownerName: "Kainoa",
      slug,
      livekitRoom: getRoom(db, slug)!.livekitRoom,
      door: "connector",
      app: "grok",
      connectorId: connector.id,
    });
    expect(attachedConnectorAgent(db, connector.id)?.identity).toBe(agent.identity);
  });

  it("can be asked for again after a reload, while it stays approved", () => {
    const { db, slug, kai, connector } = meeting();
    const { requestId } = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    decideAgentRequest(db, { slug, requestId, approve: true });
    expect(connectorAgentFor(db, kai, KAI_KEY, requestId).identity).toBe(connectorAgentFor(db, kai, KAI_KEY, requestId).identity);
  });

  it("is only the owner's to bring, and only to a meeting they're in", () => {
    const { db, slug, kai, zach, connector } = meeting();
    expect(() => requestConnectorJoin(db, zach, "zach-key", connector.id)).toThrow("No such connector");
    expect(() => requestConnectorJoin(db, kai, KAI_KEY, 42)).toThrow("No such connector");

    const { requestId } = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    decideAgentRequest(db, { slug, requestId, approve: true });
    expect(() => connectorJoinStatus(db, zach, KAI_KEY, requestId)).toThrow(HttpError);
    expect(() => connectorAgentFor(db, zach, KAI_KEY, requestId)).toThrow(HttpError);
  });

  it("needs a name no one in the meeting has", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
    addParticipant(db, { slug, name: "Grok", isHost: false });
    const { connector } = createConnector(db, KAI_KEY, { name: "Grok", app: "grok" });
    expect(() => requestConnectorJoin(db, kai, KAI_KEY, connector.id)).toThrow("already called");
  });

  it("is in one meeting at a time: joining another leaves the first", () => {
    const { db, slug, kai, connector } = meeting();
    const first = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    decideAgentRequest(db, { slug, requestId: first.requestId, approve: true });
    const firstAgent = connectorAgentFor(db, kai, KAI_KEY, first.requestId);

    const { slug: other } = createRoom(db);
    const kaiThere = addParticipant(db, { slug: other, name: "Kainoa", isHost: false });
    const second = requestConnectorJoin(db, kaiThere, KAI_KEY, connector.id);

    expect(second.superseded).toEqual([{ livekitRoom: getRoom(db, slug)!.livekitRoom, identity: firstAgent.identity }]);
    expect(isRevokedAgent(db, firstAgent.identity)).toBe(true);
    expect(connectorJoinStatus(db, kai, KAI_KEY, first.requestId)).toBe("revoked");
    expect(attachedConnectorAgent(db, connector.id)).toBeUndefined(); // the new one awaits approval
  });

  it("asking again in the same meeting replaces the earlier request", () => {
    const { db, slug, kai, connector } = meeting();
    const first = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    const second = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    expect(connectorJoinStatus(db, kai, KAI_KEY, first.requestId)).toBe("revoked");
    expect(listPendingRequests(db, slug).map((r) => r.id)).toEqual([second.requestId]);
  });

  it("stops being anyone's agent once denied or removed", () => {
    const { db, slug, kai, connector } = meeting();
    const denied = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    decideAgentRequest(db, { slug, requestId: denied.requestId, approve: false });
    expect(connectorJoinStatus(db, kai, KAI_KEY, denied.requestId)).toBe("denied");
    expect(() => connectorAgentFor(db, kai, KAI_KEY, denied.requestId)).toThrow("not approved");

    const approved = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    decideAgentRequest(db, { slug, requestId: approved.requestId, approve: true });
    const agent = connectorAgentFor(db, kai, KAI_KEY, approved.requestId);
    revokeAgent(db, { slug, agentIdentity: agent.identity });
    expect(() => connectorAgentFor(db, kai, KAI_KEY, approved.requestId)).toThrow("not approved");
    expect(attachedConnectorAgent(db, connector.id)).toBeUndefined();
  });

  it("can all be revoked at once (when the connector is deleted)", () => {
    const { db, slug, kai, connector } = meeting();
    const { requestId } = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    decideAgentRequest(db, { slug, requestId, approve: true });
    const agent = connectorAgentFor(db, kai, KAI_KEY, requestId);

    expect(revokeConnectorAgents(db, connector.id)).toEqual([
      { livekitRoom: getRoom(db, slug)!.livekitRoom, identity: agent.identity },
    ]);
    expect(isRevokedAgent(db, agent.identity)).toBe(true);
  });

  it("lapses if the host never answers", () => {
    const { db, kai, connector } = meeting();
    const { requestId } = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    db.prepare("UPDATE agent_requests SET created_at = 0 WHERE id = ?").run(requestId);
    expect(connectorJoinStatus(db, kai, KAI_KEY, requestId)).toBe("expired");
  });
});

describe("letting go of abandoned links", () => {
  function links() {
    const db = getDb();
    const { slug } = createRoom(db);
    const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
    const make = (name: string) => createConnector(db, KAI_KEY, { name, app: "grok" }).connector;
    const age = (id: string, created: number, used: number | null = null) =>
      db.prepare("UPDATE connectors SET created_at = ?, last_used_at = ? WHERE id = ?").run(created, used, id);
    const ids = () => listConnectors(db, KAI_KEY).map((c) => c.name).sort();
    return { db, slug, kai, make, age, ids };
  }

  it("deletes links never used in a meeting within a day, or not for half a year", () => {
    const { db, make, age, ids } = links();
    const now = Date.now();
    make("Fresh");
    age(make("Stale").id, now - UNUSED_LINK_TTL_MS - 1);
    age(make("Idle").id, 0, now - IDLE_LINK_TTL_MS - 1);
    age(make("Used").id, 0, now - 1000);
    pruneConnectors(db, now);
    expect(ids()).toEqual(["Fresh", "Used"]);
  });

  it("keeps one in a meeting, but not for a request left pending or an agent that never joined", () => {
    const { db, slug, kai, make, age, ids } = links();
    const now = Date.now();
    const old = now - UNUSED_LINK_TTL_MS - 1;

    const inMeeting = make("InMeeting");
    age(inMeeting.id, old);
    const live = requestConnectorJoin(db, kai, KAI_KEY, inMeeting.id);
    decideAgentRequest(db, { slug, requestId: live.requestId, approve: true });
    const agent = connectorAgentFor(db, kai, KAI_KEY, live.requestId);
    noteConnectorPresence(db, agent.identity, "PA_1", true);

    const leftPending = make("LeftPending");
    age(leftPending.id, old);
    const pending = requestConnectorJoin(db, kai, KAI_KEY, leftPending.id);
    db.prepare("UPDATE agent_requests SET created_at = ? WHERE id = ?").run(now - PENDING_TTL_MS - 1, pending.requestId);

    const neverJoined = make("NeverJoined");
    age(neverJoined.id, old);
    const unjoined = requestConnectorJoin(db, kai, KAI_KEY, neverJoined.id);
    decideAgentRequest(db, { slug, requestId: unjoined.requestId, approve: true });
    db.prepare("UPDATE agent_requests SET decided_at = ? WHERE id = ?").run(now - UNJOINED_APPROVAL_MS - 1, unjoined.requestId);

    expect(connectorInUse(db, inMeeting.id, now)).toBe(true);
    expect(connectorInUse(db, neverJoined.id, now)).toBe(false);
    pruneConnectors(db, now);
    expect(ids()).toEqual(["InMeeting"]);
    expect(connectorJoinStatus(db, kai, KAI_KEY, live.requestId, now)).toBe("approved");

    // Away past the grace period: no longer in use.
    noteConnectorPresence(db, agent.identity, "PA_1", false, now);
    expect(connectorInUse(db, inMeeting.id, now + LEFT_GRACE_MS + 1)).toBe(false);
  });
});
