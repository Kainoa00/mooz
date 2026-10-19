import { beforeEach, describe, expect, it } from "vitest";
import { decideAgentRequest, isRevokedAgent, listPendingRequests, revokeAgent } from "./agents";
import {
  attachedConnectorAgent,
  connectorAgentFor,
  connectorJoinStatus,
  requestConnectorJoin,
  revokeConnectorAgents,
} from "./connector-agents";
import { createConnector } from "./connectors";
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
    expect(connectorJoinStatus(db, kai, requestId)).toBe("pending");
    expect(listPendingRequests(db, slug)).toEqual([
      expect.objectContaining({ id: requestId, agentName: "Grok", ownerName: "Kainoa", door: "connector" }),
    ]);
    expect(() => connectorAgentFor(db, kai, requestId)).toThrow("not approved");

    decideAgentRequest(db, { slug, requestId, approve: true });

    expect(connectorJoinStatus(db, kai, requestId)).toBe("approved");
    const agent = connectorAgentFor(db, kai, requestId);
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
    expect(connectorAgentFor(db, kai, requestId).identity).toBe(connectorAgentFor(db, kai, requestId).identity);
  });

  it("is only the owner's to bring, and only to a meeting they're in", () => {
    const { db, slug, kai, zach, connector } = meeting();
    expect(() => requestConnectorJoin(db, zach, "zach-key", connector.id)).toThrow("No such connector");
    expect(() => requestConnectorJoin(db, kai, KAI_KEY, 42)).toThrow("No such connector");

    const { requestId } = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    decideAgentRequest(db, { slug, requestId, approve: true });
    expect(() => connectorJoinStatus(db, zach, requestId)).toThrow(HttpError);
    expect(() => connectorAgentFor(db, zach, requestId)).toThrow(HttpError);
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
    const firstAgent = connectorAgentFor(db, kai, first.requestId);

    const { slug: other } = createRoom(db);
    const kaiThere = addParticipant(db, { slug: other, name: "Kainoa", isHost: false });
    const second = requestConnectorJoin(db, kaiThere, KAI_KEY, connector.id);

    expect(second.superseded).toEqual([{ livekitRoom: getRoom(db, slug)!.livekitRoom, identity: firstAgent.identity }]);
    expect(isRevokedAgent(db, firstAgent.identity)).toBe(true);
    expect(connectorJoinStatus(db, kai, first.requestId)).toBe("revoked");
    expect(attachedConnectorAgent(db, connector.id)).toBeUndefined(); // the new one awaits approval
  });

  it("asking again in the same meeting replaces the earlier request", () => {
    const { db, slug, kai, connector } = meeting();
    const first = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    const second = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    expect(connectorJoinStatus(db, kai, first.requestId)).toBe("revoked");
    expect(listPendingRequests(db, slug).map((r) => r.id)).toEqual([second.requestId]);
  });

  it("stops being anyone's agent once denied or removed", () => {
    const { db, slug, kai, connector } = meeting();
    const denied = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    decideAgentRequest(db, { slug, requestId: denied.requestId, approve: false });
    expect(connectorJoinStatus(db, kai, denied.requestId)).toBe("denied");
    expect(() => connectorAgentFor(db, kai, denied.requestId)).toThrow("not approved");

    const approved = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    decideAgentRequest(db, { slug, requestId: approved.requestId, approve: true });
    const agent = connectorAgentFor(db, kai, approved.requestId);
    revokeAgent(db, { slug, agentIdentity: agent.identity });
    expect(() => connectorAgentFor(db, kai, approved.requestId)).toThrow("not approved");
    expect(attachedConnectorAgent(db, connector.id)).toBeUndefined();
  });

  it("can all be revoked at once (when the connector is deleted)", () => {
    const { db, slug, kai, connector } = meeting();
    const { requestId } = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    decideAgentRequest(db, { slug, requestId, approve: true });
    const agent = connectorAgentFor(db, kai, requestId);

    expect(revokeConnectorAgents(db, connector.id)).toEqual([
      { livekitRoom: getRoom(db, slug)!.livekitRoom, identity: agent.identity },
    ]);
    expect(isRevokedAgent(db, agent.identity)).toBe(true);
  });

  it("lapses if the host never answers", () => {
    const { db, kai, connector } = meeting();
    const { requestId } = requestConnectorJoin(db, kai, KAI_KEY, connector.id);
    db.prepare("UPDATE agent_requests SET created_at = 0 WHERE id = ?").run(requestId);
    expect(connectorJoinStatus(db, kai, requestId)).toBe("expired");
  });
});
