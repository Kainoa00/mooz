import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentCode,
  createAgentCode,
  decideAgentRequest,
  getClaimStatus,
  markTokenIssued,
  noteBridgePresence,
  revokeAgent,
} from "@/lib/agents";
import { getDb } from "@/lib/db";
import { MAX_AGENT_STREAK, SPEAKING_TURN_MS, floorView, resetFloorsForTests } from "@/lib/floor";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { addParticipant, createRoom } from "@/lib/rooms";
import { POLL_MS, TURN_REQUESTS_PER_MINUTE, type TurnJson } from "@/lib/turn-api";
import { jsonRequest, params, useTestEnv } from "@/test/helpers";

vi.mock("@/lib/livekit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/livekit")>()),
  setRoomMetadata: async () => {},
}));

const { POST: ASK } = await import("./route");
const { GET: CHECK } = await import("./[turn]/route");
const { POST: DONE } = await import("./[turn]/done/route");

beforeEach(() => {
  useTestEnv();
  resetFloorsForTests();
  resetRateLimitsForTests();
});
afterEach(() => vi.useRealTimers());

/** A meeting with bridge agents in it, each with its claim (request id and secret). */
function meeting(names = ["Atlas", "Nova"]) {
  const db = getDb();
  const { slug } = createRoom(db);
  const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
  const agents = names.map((name) => {
    const claim = claimAgentCode(db, { code: createAgentCode(db, kai).code, name });
    decideAgentRequest(db, { slug, requestId: claim.requestId, approve: true });
    const status = getClaimStatus(db, claim.requestId, claim.claimSecret);
    if (status.status !== "approved") throw new Error("setup failed");
    markTokenIssued(db, claim.requestId);
    return { ...claim, identity: status.agent.identity };
  });
  return { db, slug, agents };
}

type Claim = { requestId: string; claimSecret: string };
const base = (a: Claim) => `http://localhost/api/agent/claim/${a.requestId}/turns`;
const auth = (a: Claim, secret = a.claimSecret) => ({ authorization: `Bearer ${secret}` });

async function ask(a: Claim, body: unknown = { answering: "person", speak: true }, secret?: string) {
  const res = await ASK(jsonRequest(base(a), body, auth(a, secret)), params({ id: a.requestId }));
  return { res, turn: res.ok ? ((await res.json()) as { turn: TurnJson }).turn : undefined };
}

function check(a: Claim, turn: string, signal?: AbortSignal) {
  return CHECK(new Request(`${base(a)}/${turn}`, { headers: auth(a), signal }), params({ id: a.requestId, turn }));
}

const done = (a: Claim, turn: string) =>
  DONE(new Request(`${base(a)}/${turn}/done`, { method: "POST", headers: auth(a) }), params({ id: a.requestId, turn }));

const json = async (res: Response) => ((await res.json()) as { turn: TurnJson }).turn;

describe("bridge turns", () => {
  it("grants a free floor at once, and makes the next agent wait its turn", async () => {
    const { slug, agents } = meeting();
    const [atlas, nova] = agents;
    const first = await ask(atlas);
    expect(first.res.status).toBe(201);
    expect(first.turn).toMatchObject({ status: "granted" });
    expect(first.turn!.endsInMs).toBeGreaterThan(SPEAKING_TURN_MS - 1000);
    expect(first.turn!.endsInMs).toBeLessThanOrEqual(SPEAKING_TURN_MS);
    expect(first.res.headers.get("cache-control")).toBe("no-store");

    const second = await ask(nova);
    expect(second.turn).toMatchObject({ status: "waiting" });
    expect(floorView(slug)).toEqual({ speaking: atlas.identity, next: nova.identity, paused: false, continued: 0 });

    const waiting = check(nova, second.turn!.id);
    expect(await json(await done(atlas, first.turn!.id))).toMatchObject({ status: "ended", reason: "done" });
    expect(await json(await waiting)).toMatchObject({ status: "granted" });
  });

  it("answers a check after the poll window even if nothing changed", async () => {
    vi.useFakeTimers();
    const [atlas, nova] = meeting().agents;
    await ask(atlas);
    const { turn } = await ask(nova);
    const waiting = check(nova, turn!.id);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(await json(await waiting)).toMatchObject({ status: "waiting" });
  });

  it("stops waiting when the bridge hangs up", async () => {
    const [atlas, nova] = meeting().agents;
    await ask(atlas);
    const { turn } = await ask(nova);
    const abort = new AbortController();
    const waiting = check(nova, turn!.id, abort.signal);
    abort.abort();
    expect(await json(await waiting)).toMatchObject({ status: "waiting" });
  });

  it("holds an agent's reply to an agent after a run of them", async () => {
    const { slug, agents } = meeting();
    const [atlas, nova] = agents;
    for (let i = 0; i < MAX_AGENT_STREAK; i++) {
      const { turn } = await ask(i % 2 ? atlas : nova, { answering: "agent", speak: false });
      await done(i % 2 ? atlas : nova, turn!.id);
    }
    expect((await ask(atlas, { answering: "agent", speak: true })).turn).toMatchObject({ status: "held" });
    expect(floorView(slug).paused).toBe(true);
  });

  it.each([
    [{ answering: "someone", speak: true }],
    [{ answering: "person" }],
    [{ answering: "agent", speak: "yes" }],
  ])("refuses a bad request %j", async (body) => {
    const [atlas] = meeting(["Atlas"]).agents;
    const { res } = await ask(atlas, body);
    expect(res.status).toBe(400);
  });

  it("refuses a big body", async () => {
    const [atlas] = meeting(["Atlas"]).agents;
    const { res } = await ask(atlas, { answering: "person", speak: true, pad: "x".repeat(2000) });
    expect(res.status).toBe(413);
  });

  it("needs the claim secret, and an agent still in the meeting", async () => {
    const { db, slug, agents } = meeting(["Atlas"]);
    const [atlas] = agents;
    expect((await ask(atlas, undefined, "wrong")).res.status).toBe(404);
    const noAuth = await ASK(jsonRequest(base(atlas), { answering: "person", speak: true }), params({ id: atlas.requestId }));
    expect(noAuth.status).toBe(404);

    const { turn } = await ask(atlas);
    noteBridgePresence(db, atlas.identity, "PA_1", true);
    noteBridgePresence(db, atlas.identity, "PA_1", false);
    expect((await ask(atlas)).res.status).toBe(409);
    expect((await check(atlas, turn!.id)).status).toBe(409);
    expect((await done(atlas, turn!.id)).status).toBe(409);

    noteBridgePresence(db, atlas.identity, "PA_2", true);
    revokeAgent(db, { slug, agentIdentity: atlas.identity });
    expect((await ask(atlas)).res.status).toBe(409);
  });

  it("gives nothing to an agent removed while its request was on the way", async () => {
    const { db, slug, agents } = meeting(["Atlas"]);
    const [atlas] = agents;
    let send!: () => void;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise<void>((r) => (send = r));
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ answering: "person", speak: true })));
        controller.close();
      },
    });
    const slow = new Request(base(atlas), {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(atlas) },
      body,
      duplex: "half",
    } as RequestInit);
    const pending = ASK(slow, params({ id: atlas.requestId }));
    await vi.waitFor(() => expect(send).toBeDefined());
    revokeAgent(db, { slug, agentIdentity: atlas.identity });
    send();
    expect((await pending).status).toBe(409);
    expect(floorView(slug).speaking).toBeNull();
  });

  it("only lets an agent see its own turns", async () => {
    const [atlas, nova] = meeting().agents;
    const { turn } = await ask(atlas);
    expect((await check(nova, turn!.id)).status).toBe(404);
    expect((await done(nova, turn!.id)).status).toBe(404);
    expect((await check(atlas, "t_nope")).status).toBe(404);
  });

  it("limits how often an agent asks", async () => {
    const [atlas] = meeting(["Atlas"]).agents;
    const statuses: number[] = [];
    for (let i = 0; i <= TURN_REQUESTS_PER_MINUTE; i++) statuses.push((await ask(atlas)).res.status);
    expect(statuses.slice(0, -1).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("takes 60 dones a minute, counted before the turn is looked up", async () => {
    const { agents } = meeting();
    const [atlas] = agents;
    const statuses: number[] = [];
    for (let i = 0; i <= 2 * TURN_REQUESTS_PER_MINUTE; i++) statuses.push((await done(atlas, "t_nope")).status);
    expect(new Set(statuses.slice(0, -1))).toEqual(new Set([404]));
    expect(statuses.at(-1)).toBe(429);
  });
});
