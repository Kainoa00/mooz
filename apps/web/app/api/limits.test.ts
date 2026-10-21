import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCode, decideAgentRequest } from "@/lib/agents";
import { getDb } from "@/lib/db";
import {
  HOST_SESSIONS,
  MAX_PARTICIPANT_ROWS,
  MAX_ROOM_SESSIONS,
  UNCONNECTED_PLACE_MS,
  addParticipant,
  createRoom,
} from "@/lib/rooms";
import { noteWebhook } from "@/lib/webhook-seen";
import { jsonRequest, params, setCookies, useTestEnv } from "@/test/helpers";
import { POST as claim } from "./agent/claim/route";
import { GET as poll, POLLS_PER_MINUTE } from "./agent/claim/[id]/route";
import { POST as createConnector } from "./connectors/route";
import { POST as decide } from "./rooms/[slug]/agent-requests/[id]/route";
import { POST as bringConnector } from "./rooms/[slug]/connector-requests/route";
import { POST as join, JOINS_PER_MINUTE } from "./rooms/[slug]/join/route";
import { POST as optOut } from "./rooms/[slug]/notes-opt-out/route";
import { POST as notesPolicy } from "./rooms/[slug]/notes-policy/route";
import { POST as createRoomRoute, ROOMS_PER_MINUTE } from "./rooms/route";

const START = new Date("2026-10-21T12:00:00Z");

beforeEach(() => {
  useTestEnv();
  vi.useFakeTimers({ now: START, toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

const nextMinute = () => vi.setSystemTime(Date.now() + 60_000);

async function statuses(n: number, send: (i: number) => Promise<Response>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send(i)).status);
  return out;
}

async function code(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("rate limits", () => {
  it("starts at most 30 meetings a minute across the server", async () => {
    const make = () => createRoomRoute(new Request("http://localhost:3000/api/rooms", { method: "POST" }));
    expect(new Set(await statuses(ROOMS_PER_MINUTE, make))).toEqual(new Set([201]));
    const refused = await make();
    expect(refused.status).toBe(429);
    expect(await code(refused)).toBe("rate_limited");
    nextMinute();
    expect((await make()).status).toBe(201);
  });

  it("lets 30 people a minute join a meeting, each meeting on its own", async () => {
    const db = getDb();
    const a = createRoom(db).slug;
    const b = createRoom(db).slug;
    const enter = (slug: string, i: number) =>
      join(jsonRequest(`http://localhost:3000/api/rooms/${slug}/join`, { name: `Person ${String.fromCharCode(65 + (i % 26))}` }), params({ slug }));
    expect(new Set(await statuses(JOINS_PER_MINUTE, (i) => enter(a, i)))).toEqual(new Set([200]));
    const refused = await enter(a, 0);
    expect(refused.status).toBe(429);
    expect(await code(refused)).toBe("rate_limited");
    expect((await enter(b, 0)).status).toBe(200);
    nextMinute();
    expect((await enter(a, 0)).status).toBe(200);
  });

  it("counts the host's joins and people's reloads apart, so strangers can't keep them out", async () => {
    const db = getDb();
    const { slug, hostSecret } = createRoom(db);
    const url = `http://localhost:3000/api/rooms/${slug}/join`;
    const zach = await join(jsonRequest(url, { name: "Zach" }), params({ slug }));
    const { identity } = (await zach.json()) as { identity: string };
    const secret = setCookies(zach)[`mooz_p_${slug}`];
    // Junk that never says who it is doesn't count at all.
    for (let i = 0; i < 40; i++) await join(new Request(url, { method: "POST" }), params({ slug }));
    for (let i = 0; i < JOINS_PER_MINUTE; i++) await join(jsonRequest(url, { name: `Stranger ${i}` }), params({ slug }));
    expect((await join(jsonRequest(url, { name: "Lee" }), params({ slug }))).status).toBe(429);
    const host = await join(jsonRequest(url, { name: "Kainoa" }, { cookie: `mooz_host_${slug}=${hostSecret}` }), params({ slug }));
    expect(host.status).toBe(200);
    const back = await join(jsonRequest(url, { name: "Zach", rejoin: identity }, { cookie: `mooz_p_${slug}=${secret}` }), params({ slug }));
    expect(back.status).toBe(200);
  });

  it("keeps track of at most 200 people a meeting, but lets them come back", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const url = `http://localhost:3000/api/rooms/${slug}/join`;
    const first = await join(jsonRequest(url, { name: "Zach" }), params({ slug }));
    const { identity } = (await first.json()) as { identity: string };
    const secret = setCookies(first)[`mooz_p_${slug}`];
    for (let i = 1; i < MAX_PARTICIPANT_ROWS; i++) addParticipant(db, { slug, name: "Someone", isHost: false });

    const full = await join(jsonRequest(url, { name: "Kainoa" }), params({ slug }));
    expect(full.status).toBe(409);
    expect(await code(full)).toBe("room_full");
    const back = await join(
      jsonRequest(url, { name: "Zach", rejoin: identity }, { cookie: `mooz_p_${slug}=${secret}` }),
      params({ slug }),
    );
    expect(back.status).toBe(200);
  });

  it("doesn't keep a place for joins that never came into the call, where the webhook says who did", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const url = `http://localhost:3000/api/rooms/${slug}/join`;
    noteWebhook(db); // in any meeting: this one has nobody in it yet (a new link, or one that ended)
    const long = Date.now() - UNCONNECTED_PLACE_MS - 1;
    for (let i = 0; i < MAX_PARTICIPANT_ROWS; i++) addParticipant(db, { slug, name: "Ghost", isHost: false }, long);
    expect((await join(jsonRequest(url, { name: "Kainoa" }), params({ slug }))).status).toBe(200);
  });

  it("always lets the host in", async () => {
    const db = getDb();
    const { slug, hostSecret } = createRoom(db);
    const url = `http://localhost:3000/api/rooms/${slug}/join`;
    for (let i = 0; i < MAX_PARTICIPANT_ROWS; i++) addParticipant(db, { slug, name: "Ghost", isHost: false });
    expect(await code(await join(jsonRequest(url, { name: "Lee" }), params({ slug })))).toBe("room_full");
    const host = await join(jsonRequest(url, { name: "Kainoa" }, { cookie: `mooz_host_${slug}=${hostSecret}` }), params({ slug }));
    expect(host.status).toBe(200);
  });

  it("holds at most 2000 sessions a meeting, places or not", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const url = `http://localhost:3000/api/rooms/${slug}/join`;
    noteWebhook(db);
    const insert = db.prepare(
      "INSERT INTO participants (identity, room_slug, name, is_host, secret_hash, created_at, expires_at) VALUES (?, ?, 'Ghost', 0, 's', ?, ?)",
    );
    const long = Date.now() - UNCONNECTED_PLACE_MS - 1;
    for (let i = 0; i < MAX_ROOM_SESSIONS; i++) insert.run(`p_ghost${i}`, slug, long, Date.now() + 60_000);
    expect(await code(await join(jsonRequest(url, { name: "Lee" }), params({ slug })))).toBe("room_full");
    // Sessions that have ended don't count, swept or not.
    db.prepare("UPDATE participants SET expires_at = ? WHERE identity = 'p_ghost0'").run(Date.now());
    expect((await join(jsonRequest(url, { name: "Lee" }), params({ slug }))).status).toBe(200);
  });

  it("lets the host past a full meeting, though not without end", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const insert = db.prepare(
      "INSERT INTO participants (identity, room_slug, name, is_host, secret_hash, created_at, expires_at) VALUES (?, ?, 'Ghost', 0, 's', ?, ?)",
    );
    for (let i = 0; i < MAX_ROOM_SESSIONS; i++) insert.run(`p_ghost${i}`, slug, Date.now(), Date.now() + 60_000);
    expect(() => addParticipant(db, { slug, name: "Lee", isHost: false })).toThrow("full");
    for (let i = 1; i < HOST_SESSIONS; i++) addParticipant(db, { slug, name: "Kainoa", isHost: true });
    expect(addParticipant(db, { slug, name: "Kainoa", isHost: true }).isHost).toBe(true);
    expect(() => addParticipant(db, { slug, name: "Kainoa", isHost: true })).toThrow("full");
  });

  it("refuses made-up codes without counting them, so a flood of them can't hold up a real one", async () => {
    const send = (i: number) =>
      claim(jsonRequest("http://localhost/api/agent/claim", { code: `ABCD-EFGH-${String(i).padStart(4, "A")}`, name: "Grok" }));
    expect(new Set(await statuses(500, send))).toEqual(new Set([400]));
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    const { code: real } = createAgentCode(db, zach);
    expect((await claim(jsonRequest("http://localhost/api/agent/claim", { code: real, name: "Grok" }))).status).toBe(201);
  });

  it("answers a claim's checks 60 times a minute, and doesn't count made-up ones", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
    const { code: real } = createAgentCode(db, zach);
    const { requestId, claimSecret } = (await (
      await claim(jsonRequest("http://localhost/api/agent/claim", { code: real, name: "Grok" }))
    ).json()) as { requestId: string; claimSecret: string };
    const check = (secret: string) =>
      poll(
        new Request(`http://localhost/api/agent/claim/${requestId}`, { headers: { authorization: `Bearer ${secret}` } }),
        params({ id: requestId }),
      );

    expect(new Set(await statuses(100, () => check("wrong")))).toEqual(new Set([404]));
    expect(new Set(await statuses(POLLS_PER_MINUTE, () => check(claimSecret)))).toEqual(new Set([200]));
    const refused = await check(claimSecret);
    expect(refused.status).toBe(429);
    expect(await code(refused)).toBe("rate_limited");

    // A limited check doesn't spend the approval's one token, even once it's approved.
    decideAgentRequest(db, { slug, requestId, approve: true });
    expect((await check(claimSecret)).status).toBe(429);
    nextMinute();
    expect(await (await check(claimSecret)).json()).toMatchObject({ status: "approved", token: expect.any(String) });
  });
});

describe("small bodies", () => {
  const big = { name: "x".repeat(5000), decision: "approve", allowed: true, optOut: true, slug: "x", connectorId: "c" };

  it.each([
    ["join", (slug: string) => join(jsonRequest(`http://localhost/api/rooms/${slug}/join`, big), params({ slug }))],
    ["claim", () => claim(jsonRequest("http://localhost/api/agent/claim", big))],
    ["a decision", (slug: string, cookie: string) =>
      decide(jsonRequest(`http://localhost/api/rooms/${slug}/agent-requests/r_1`, big, { cookie }), params({ slug, id: "r_1" }))],
    ["the notes policy", (slug: string, cookie: string) =>
      notesPolicy(jsonRequest(`http://localhost/api/rooms/${slug}/notes-policy`, big, { cookie }), params({ slug }))],
    ["a notes opt-out", (slug: string, cookie: string) =>
      optOut(jsonRequest(`http://localhost/api/rooms/${slug}/notes-opt-out`, big, { cookie }), params({ slug }))],
    ["a new connector", () => createConnector(jsonRequest("http://localhost/api/connectors", big))],
    ["bringing a connector", (slug: string, cookie: string) =>
      bringConnector(jsonRequest(`http://localhost/api/rooms/${slug}/connector-requests`, big, { cookie }), params({ slug }))],
  ] as const)("refuses more than 4 KB for %s", async (_what, send) => {
    const db = getDb();
    const { slug, hostSecret } = createRoom(db);
    const me = addParticipant(db, { slug, name: "Kainoa", isHost: true });
    const res = await send(slug, `mooz_host_${slug}=${hostSecret}; mooz_p_${slug}=${me.secret}`);
    expect(res.status).toBe(413);
    expect(await code(res)).toBe("too_large");
  });
});
