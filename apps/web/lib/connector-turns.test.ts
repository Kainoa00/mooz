import { describe, expect, it, vi } from "vitest";
import { TurnQueues, takeTurn } from "./connector-turns";

const BASE = "/api/rooms/abc/connector-requests/r_1";

type Reply = { status: number; body?: unknown } | Error;

/** A fetch that answers from a script, recording what was asked. */
function server(replies: Record<string, Reply[]>) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = replies[`${method} ${url}`]?.shift();
    if (!next) throw new Error(`unexpected ${method} ${url}`);
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? "<html>404</html>" : JSON.stringify(next.body), {
      status: next.status,
      headers: next.body === undefined ? {} : { "content-type": "application/json" },
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const turn = (status: string, extra: Record<string, unknown> = {}) => ({ status: 200, body: { turn: { id: "t_1", status, ...extra } } });

function deps(fetch: typeof globalThis.fetch, start = 1000) {
  let t = start;
  return { fetch, now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => (t += ms) };
}

describe("takeTurn", () => {
  it("takes a free floor at once, until when it ends, and gives it back", async () => {
    const { fetch, calls } = server({
      [`POST ${BASE}/turns`]: [{ status: 201, body: { turn: { id: "t_1", status: "granted", endsInMs: 45000 } } }],
      [`POST ${BASE}/turns/t_1/done`]: [turn("ended")],
    });
    const held = await takeTurn(BASE, { answering: "person", speak: true }, deps(fetch));
    expect(held).toMatchObject({ until: 46000 });
    expect(calls[0]).toMatchObject({ body: { answering: "person", speak: true } });
    await held!.release();
    expect(calls.at(-1)?.url).toBe(`${BASE}/turns/t_1/done`);
  });

  it("waits while its turn is waiting or held", async () => {
    const { fetch, calls } = server({
      [`POST ${BASE}/turns`]: [{ status: 201, body: { turn: { id: "t_1", status: "held" } } }],
      [`GET ${BASE}/turns/t_1`]: [turn("held"), new Error("offline"), turn("granted", { endsInMs: 1000 })],
    });
    const held = await takeTurn(BASE, { answering: "agent", speak: false }, deps(fetch));
    expect(held).not.toBeNull();
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });

  it("gives up after a while, or at once when told not to wait, and withdraws", async () => {
    const d = deps(
      server({
        [`POST ${BASE}/turns`]: [{ status: 201, body: { turn: { id: "t_1", status: "waiting" } } }],
        [`GET ${BASE}/turns/t_1`]: [turn("waiting")],
        [`POST ${BASE}/turns/t_1/done`]: [turn("ended")],
      }).fetch,
    );
    const slow = { ...d, fetch: (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") d.advance(400_000);
      return d.fetch(url, init);
    }) as typeof globalThis.fetch };
    expect(await takeTurn(BASE, { answering: "agent", speak: true }, slow)).toBeNull();

    const { fetch, calls } = server({
      [`POST ${BASE}/turns`]: [{ status: 201, body: { turn: { id: "t_1", status: "waiting" } } }],
      [`POST ${BASE}/turns/t_1/done`]: [turn("ended")],
    });
    expect(await takeTurn(BASE, { answering: "person", speak: true, maxWaitMs: 0 }, deps(fetch))).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
  });

  it("says nothing when the turn ends first or the server refuses", async () => {
    const ended = server({
      [`POST ${BASE}/turns`]: [{ status: 201, body: { turn: { id: "t_1", status: "waiting" } } }],
      [`GET ${BASE}/turns/t_1`]: [turn("ended", { reason: "replaced" })],
    });
    expect(await takeTurn(BASE, { answering: "person", speak: true }, deps(ended.fetch))).toBeNull();
    const refused = server({
      [`POST ${BASE}/turns`]: [{ status: 409, body: { error: { code: "not_approved", message: "No" } } }],
    });
    expect(await takeTurn(BASE, { answering: "person", speak: true }, deps(refused.fetch))).toBeNull();
    const lost = server({
      [`POST ${BASE}/turns`]: [{ status: 201, body: { turn: { id: "t_1", status: "waiting" } } }],
      [`GET ${BASE}/turns/t_1`]: [{ status: 404, body: { error: { code: "turn_not_found" } } }],
    });
    expect(await takeTurn(BASE, { answering: "person", speak: true }, deps(lost.fetch))).toBeNull();
  });

  it("answers a person, but not an agent, when the server can't be reached or answers nonsense", async () => {
    for (const reply of [new Error("offline"), { status: 502 }, { status: 200, body: { nope: true } }]) {
      const person = server({ [`POST ${BASE}/turns`]: [reply as Reply] });
      const held = await takeTurn(BASE, { answering: "person", speak: true }, deps(person.fetch));
      expect(held).toEqual({ release: expect.any(Function) });
      await held!.release();
      const agent = server({ [`POST ${BASE}/turns`]: [reply as Reply] });
      expect(await takeTurn(BASE, { answering: "agent", speak: true }, deps(agent.fetch))).toBeNull();
    }
  });

  it("doesn't mind a failed release: the turn runs out on its own", async () => {
    const { fetch } = server({
      [`POST ${BASE}/turns`]: [{ status: 201, body: { turn: { id: "t_1", status: "granted", endsInMs: 1000 } } }],
      [`POST ${BASE}/turns/t_1/done`]: [new Error("offline")],
    });
    const held = await takeTurn(BASE, { answering: "person", speak: true }, deps(fetch));
    await expect(held!.release()).resolves.toBeUndefined();
  });
});

describe("TurnQueues", () => {
  it("runs one job of each kind at a time, the kinds side by side", async () => {
    const queues = new TurnQueues();
    const order: string[] = [];
    let release!: () => void;
    const first = queues.run("agent", async () => {
      order.push("agent 1 start");
      await new Promise<void>((r) => (release = r));
      order.push("agent 1 end");
      return 1;
    });
    const second = queues.run("agent", async () => {
      order.push("agent 2");
      return 2;
    });
    const person = queues.run("person", async () => {
      order.push("person");
      throw new Error("boom");
    });
    await expect(person).rejects.toThrow("boom");
    expect(order).toEqual(["agent 1 start", "person"]);
    release();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(["agent 1 start", "person", "agent 1 end", "agent 2"]);
    await expect(queues.run("person", async () => "after a failure")).resolves.toBe("after a failure");
  });
});
