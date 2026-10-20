import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CODE_TTL_MS,
  APPROVAL_WINDOW_MS,
  MAX_NAME_ATTEMPTS,
  PENDING_TTL_MS,
  activeAgentNames,
  isRevokedAgent,
  markTokenIssued,
  revokeAgent,
  claimAgentCode,
  createAgentCode,
  decideAgentRequest,
  getClaimStatus,
  listPendingRequests,
  noteBridgePresence,
  requireBridgeAgent,
} from "./agents";
import { getDb } from "./db";
import { addParticipant, createRoom } from "./rooms";
import { useTestEnv } from "@/test/helpers";

beforeEach(useTestEnv);
afterEach(() => vi.useRealTimers());

function meeting() {
  const db = getDb();
  const { slug } = createRoom(db);
  const host = addParticipant(db, { slug, name: "Kainoa", isHost: true });
  const guest = addParticipant(db, { slug, name: "Zach", isHost: false });
  return { db, slug, host, guest };
}

describe("createAgentCode", () => {
  it("makes a readable one-time code bound to its owner", () => {
    const { db, guest } = meeting();

    const { code, expiresAt } = createAgentCode(db, guest);

    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(expiresAt - Date.now()).toBeGreaterThan(AGENT_CODE_TTL_MS - 1000);
  });
});

describe("claimAgentCode", () => {
  it("creates a pending request owned by the code's creator", () => {
    const { db, slug, guest } = meeting();
    const { code } = createAgentCode(db, guest);

    const claim = claimAgentCode(db, { code, name: "Grok" });

    expect(claim).toEqual({ requestId: expect.any(String), claimSecret: expect.any(String), status: "pending" });
    expect(listPendingRequests(db, slug)).toEqual([
      expect.objectContaining({ id: claim.requestId, agentName: "Grok", ownerName: "Zach" }),
    ]);
  });

  it("accepts the code regardless of case and dashes", () => {
    const { db, guest } = meeting();
    const { code } = createAgentCode(db, guest);

    expect(() => claimAgentCode(db, { code: code.toLowerCase().replaceAll("-", ""), name: "Grok" })).not.toThrow();
  });

  it("can only be used once", () => {
    const { db, guest } = meeting();
    const { code } = createAgentCode(db, guest);
    claimAgentCode(db, { code, name: "Grok" });

    expect(() => claimAgentCode(db, { code, name: "Other" })).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_code" }),
    );
  });

  it("rejects an expired code", () => {
    vi.useFakeTimers();
    const { db, guest } = meeting();
    const { code } = createAgentCode(db, guest);
    vi.advanceTimersByTime(AGENT_CODE_TTL_MS + 1);

    expect(() => claimAgentCode(db, { code, name: "Grok" })).toThrowError(
      expect.objectContaining({ code: "invalid_code" }),
    );
  });

  it("rejects an unknown code", () => {
    const { db } = meeting();

    expect(() => claimAgentCode(db, { code: "AAAA-BBBB-CCCC", name: "Grok" })).toThrowError(
      expect.objectContaining({ code: "invalid_code" }),
    );
  });

  it("does not burn the code when the name is rejected", () => {
    const { db, guest } = meeting();
    const { code } = createAgentCode(db, guest);

    expect(() => claimAgentCode(db, { code, name: "mooz" })).toThrow();
    expect(() => claimAgentCode(db, { code, name: "Grok" })).not.toThrow();
  });

  it("rejects a name taken by another agent or a person in the meeting", () => {
    const { db, host, guest } = meeting();
    claimAgentCode(db, { code: createAgentCode(db, host).code, name: "Atlas" });

    expect(() => claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "atlas" })).toThrowError(
      expect.objectContaining({ code: "name_taken" }),
    );
    expect(() => claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "Kainoa" })).toThrowError(
      expect.objectContaining({ code: "name_taken" }),
    );
  });

  it("rejects a name the detector would confuse with an agent's or a person's", () => {
    const { db, host, guest } = meeting();
    claimAgentCode(db, { code: createAgentCode(db, host).code, name: "Grok" });

    for (const name of ["Grock", "Grok Prime", "Kainoah"]) {
      expect(() => claimAgentCode(db, { code: createAgentCode(db, guest).code, name })).toThrowError(
        expect.objectContaining({ code: "name_taken" }),
      );
    }
    expect(() => claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "Atlas" })).not.toThrow();
  });

  it("frees the name of a denied agent", () => {
    const { db, slug, host } = meeting();
    const first = claimAgentCode(db, { code: createAgentCode(db, host).code, name: "Atlas" });
    decideAgentRequest(db, { slug, requestId: first.requestId, approve: false });

    expect(() => claimAgentCode(db, { code: createAgentCode(db, host).code, name: "Atlas" })).not.toThrow();
  });
});

describe("decideAgentRequest and getClaimStatus", () => {
  it("withholds the agent identity until the host approves", () => {
    const { db, slug, guest } = meeting();
    const claim = claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "Grok" });

    expect(getClaimStatus(db, claim.requestId, claim.claimSecret)).toEqual({ status: "pending" });

    decideAgentRequest(db, { slug, requestId: claim.requestId, approve: true });

    expect(getClaimStatus(db, claim.requestId, claim.claimSecret)).toEqual({
      status: "approved",
      agent: {
        identity: expect.stringMatching(/^a_/),
        slug,
        livekitRoom: expect.stringMatching(/^lk_/),
        name: "Grok",
        ownerIdentity: guest.identity,
        ownerName: "Zach",
      },
    });
    expect(listPendingRequests(db, slug)).toEqual([]);
  });

  it("reports a denial", () => {
    const { db, slug, guest } = meeting();
    const claim = claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "Grok" });

    decideAgentRequest(db, { slug, requestId: claim.requestId, approve: false });

    expect(getClaimStatus(db, claim.requestId, claim.claimSecret)).toEqual({ status: "denied" });
  });

  it("rejects polling with the wrong claim secret", () => {
    const { db, guest } = meeting();
    const claim = claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "Grok" });

    expect(() => getClaimStatus(db, claim.requestId, "wrong")).toThrowError(
      expect.objectContaining({ status: 404, code: "request_not_found" }),
    );
    expect(() => getClaimStatus(db, claim.requestId, undefined)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });

  it("cannot decide a request from another room or decide twice", () => {
    const { db, slug, guest } = meeting();
    const other = createRoom(db);
    const claim = claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "Grok" });

    expect(() => decideAgentRequest(db, { slug: other.slug, requestId: claim.requestId, approve: true })).toThrowError(
      expect.objectContaining({ status: 404 }),
    );

    decideAgentRequest(db, { slug, requestId: claim.requestId, approve: true });
    expect(() => decideAgentRequest(db, { slug, requestId: claim.requestId, approve: false })).toThrowError(
      expect.objectContaining({ status: 409, code: "already_decided" }),
    );
  });
});

describe("security hardening", () => {
  it("burns a code after too many rejected names, so it cannot probe attendee names", () => {
    const { db, guest } = meeting();
    const { code } = createAgentCode(db, guest);
    for (let i = 0; i < MAX_NAME_ATTEMPTS; i++) {
      expect(() => claimAgentCode(db, { code, name: "Kainoa" })).toThrowError(
        expect.objectContaining({ code: "name_taken" }),
      );
    }

    expect(() => claimAgentCode(db, { code, name: "Grok" })).toThrowError(
      expect.objectContaining({ code: "invalid_code" }),
    );
  });

  it("stops issuing tokens once the approval window has passed", () => {
    vi.useFakeTimers();
    const { db, slug, guest } = meeting();
    const claim = claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "Grok" });
    decideAgentRequest(db, { slug, requestId: claim.requestId, approve: true });
    vi.advanceTimersByTime(APPROVAL_WINDOW_MS + 1);

    expect(getClaimStatus(db, claim.requestId, claim.claimSecret)).toEqual({ status: "expired" });
  });

  it("lets the host revoke an approved agent for good", () => {
    const { db, slug, guest } = meeting();
    const claim = claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "Grok" });
    decideAgentRequest(db, { slug, requestId: claim.requestId, approve: true });
    const status = getClaimStatus(db, claim.requestId, claim.claimSecret);
    const identity = status.status === "approved" ? status.agent.identity : "";

    revokeAgent(db, { slug, agentIdentity: identity });

    expect(getClaimStatus(db, claim.requestId, claim.claimSecret)).toEqual({ status: "revoked" });
    expect(activeAgentNames(db, slug)).toEqual([]);
    // Repeatable, so a failed disconnect can be retried.
    expect(() => revokeAgent(db, { slug, agentIdentity: identity })).not.toThrow();
    expect(isRevokedAgent(db, identity)).toBe(true);
  });

  it("lets a pending request lapse so it cannot squat a name", () => {
    vi.useFakeTimers();
    const { db, slug, guest } = meeting();
    const claim = claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "Bob" });
    vi.advanceTimersByTime(PENDING_TTL_MS + 1);

    expect(activeAgentNames(db, slug)).toEqual([]);
    expect(listPendingRequests(db, slug)).toEqual([]);
    expect(getClaimStatus(db, claim.requestId, claim.claimSecret)).toEqual({ status: "expired" });
    expect(() => decideAgentRequest(db, { slug, requestId: claim.requestId, approve: true })).toThrowError(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("hands out each approval's token only once", () => {
    const { db, slug, guest } = meeting();
    const claim = claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "Grok" });
    decideAgentRequest(db, { slug, requestId: claim.requestId, approve: true });

    expect(markTokenIssued(db, claim.requestId)).toBe(true);
    expect(markTokenIssued(db, claim.requestId)).toBe(false);
    expect(getClaimStatus(db, claim.requestId, claim.claimSecret)).toEqual({ status: "expired" });
  });

  it("cannot revoke an agent from another meeting", () => {
    const { db, slug, guest } = meeting();
    const other = createRoom(db);
    const claim = claimAgentCode(db, { code: createAgentCode(db, guest).code, name: "Grok" });
    decideAgentRequest(db, { slug, requestId: claim.requestId, approve: true });
    const status = getClaimStatus(db, claim.requestId, claim.claimSecret);
    const identity = status.status === "approved" ? status.agent.identity : "";

    expect(() => revokeAgent(db, { slug: other.slug, agentIdentity: identity })).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe("requireBridgeAgent", () => {
  function approved() {
    const m = meeting();
    const claim = claimAgentCode(m.db, { code: createAgentCode(m.db, m.guest).code, name: "Grok" });
    decideAgentRequest(m.db, { slug: m.slug, requestId: claim.requestId, approve: true });
    const status = getClaimStatus(m.db, claim.requestId, claim.claimSecret);
    const identity = status.status === "approved" ? status.agent.identity : "";
    return { ...m, ...claim, identity };
  }

  it("is the agent in the meeting, once it has its token", () => {
    const { db, slug, requestId, claimSecret, identity } = approved();
    expect(() => requireBridgeAgent(db, requestId, claimSecret)).toThrowError(
      expect.objectContaining({ status: 409, code: "not_in_meeting" }),
    );
    markTokenIssued(db, requestId);
    expect(requireBridgeAgent(db, requestId, claimSecret)).toMatchObject({ identity, slug, name: "Grok" });
  });

  it("needs the claim secret", () => {
    const { db, requestId, claimSecret } = approved();
    markTokenIssued(db, requestId);
    for (const [id, secret] of [
      [requestId, undefined],
      [requestId, "wrong"],
      ["r_nope", claimSecret],
    ] as const) {
      expect(() => requireBridgeAgent(db, id, secret)).toThrowError(
        expect.objectContaining({ status: 404, code: "request_not_found" }),
      );
    }
  });

  it("is gone once removed, or once it left the meeting (until LiveKit says it's back)", () => {
    const { db, slug, requestId, claimSecret, identity } = approved();
    markTokenIssued(db, requestId);
    noteBridgePresence(db, identity, "PA_1", true);
    noteBridgePresence(db, identity, "PA_old", false); // a late "left" for an older connection
    expect(() => requireBridgeAgent(db, requestId, claimSecret)).not.toThrow();
    noteBridgePresence(db, identity, "PA_1", false);
    expect(() => requireBridgeAgent(db, requestId, claimSecret)).toThrowError(
      expect.objectContaining({ code: "not_in_meeting" }),
    );
    noteBridgePresence(db, identity, "PA_2", true);
    expect(() => requireBridgeAgent(db, requestId, claimSecret)).not.toThrow();
    revokeAgent(db, { slug, agentIdentity: identity });
    expect(() => requireBridgeAgent(db, requestId, claimSecret)).toThrowError(
      expect.objectContaining({ code: "not_in_meeting" }),
    );
  });
});
