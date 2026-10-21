import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UNSEEN_NAMES, createAgentCode, decideAgentRequest, participantNames } from "@/lib/agents";
import { getDb } from "@/lib/db";
import {
  HOST_SESSIONS,
  MAX_PARTICIPANT_ROWS,
  MAX_ROOM_SESSIONS,
  SESSION_TTL_MS,
  UNCONNECTED_PLACE_MS,
  addParticipant,
  createRoom,
  getRoom,
  notePersonPresence,
  renameParticipant,
} from "@/lib/rooms";
import { TOKEN_TTL_MS } from "@/lib/livekit";
import { noteRoomWebhook, noteWebhook } from "@/lib/webhook-seen";
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

  it("holds sessions only up to a backstop the join limit can't reach in a day", () => {
    expect(JOINS_PER_MINUTE * (SESSION_TTL_MS / 60_000 + 1)).toBeLessThan(MAX_ROOM_SESSIONS);
  });

  it("still lets newcomers in after hours of joins that never stay, where the webhook says who's in", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const url = `http://localhost:3000/api/rooms/${slug}/join`;
    noteWebhook(db);
    const insert = db.prepare(
      "INSERT INTO participants (identity, room_slug, name, is_host, secret_hash, created_at, expires_at, session_sid, left_at) VALUES (?, ?, 'Ghost', 0, 's', ?, ?, ?, ?)",
    );
    const long = Date.now() - UNCONNECTED_PLACE_MS - 1;
    // Three hours' worth at the join limit: half never connect, half come in for a moment and leave.
    for (let i = 0; i < 3 * 60 * JOINS_PER_MINUTE; i++) {
      insert.run(`p_ghost${i}`, slug, long, Date.now() + 60_000, i % 2 ? `PA_${i}` : null, i % 2 ? long : null);
    }
    noteRoomWebhook(db, getRoom(db, slug)!.livekitRoom); // the meeting is under way
    expect((await join(jsonRequest(url, { name: "Lee" }), params({ slug }))).status).toBe(200);
  });

  it("holds at most MAX_ROOM_SESSIONS sessions a meeting, places or not", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const url = `http://localhost:3000/api/rooms/${slug}/join`;
    noteWebhook(db);
    const insert = db.prepare(
      "INSERT INTO participants (identity, room_slug, name, is_host, secret_hash, created_at, expires_at) VALUES (?, ?, 'Ghost', 0, 's', ?, ?)",
    );
    const long = Date.now() - UNCONNECTED_PLACE_MS - 1;
    db.exec("BEGIN");
    for (let i = 0; i < MAX_ROOM_SESSIONS; i++) insert.run(`p_ghost${i}`, slug, long, Date.now() + 60_000);
    db.exec("COMMIT");
    noteRoomWebhook(db, getRoom(db, slug)!.livekitRoom);
    expect(await code(await join(jsonRequest(url, { name: "Lee" }), params({ slug })))).toBe("room_full");
    // Sessions that have ended don't count, swept or not.
    db.prepare("UPDATE participants SET expires_at = ? WHERE identity = 'p_ghost0'").run(Date.now());
    expect((await join(jsonRequest(url, { name: "Lee" }), params({ slug }))).status).toBe(200);
  });

  it("counts the 2,000 joins nobody saw come in that first joined most recently, where the webhook vouches for them", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const url = `http://localhost:3000/api/rooms/${slug}/join`;
    noteWebhook(db);
    const insert = db.prepare(
      "INSERT INTO participants (identity, room_slug, name, is_host, secret_hash, created_at, expires_at, session_sid) VALUES (?, ?, ?, 0, 's', ?, ?, ?)",
    );
    // Joined in the last hour (their tokens still work), and the webhook has spoken of the meeting since.
    const start = Date.now() - 50 * 60_000;
    db.exec("BEGIN");
    insert.run("p_in", slug, "Zach", start, start + SESSION_TTL_MS, "PA_zach"); // came in
    for (let i = 0; i < MAX_UNSEEN_NAMES + 100; i++) insert.run(`p_ghost${i}`, slug, `Ghost ${i}`, start + i, start + i + SESSION_TTL_MS, null);
    db.exec("COMMIT");
    // The oldest reload, which doesn't make them newer; then the webhook speaks of the meeting.
    for (let i = 0; i < 100; i++) renameParticipant(db, { identity: `p_ghost${i}`, slug, name: `Ghost ${i}`, isHost: false }, `Ghost ${i}`, false);
    noteRoomWebhook(db, getRoom(db, slug)!.livekitRoom, Date.now() + 1);
    const names = participantNames(db, slug);
    expect(names).toHaveLength(MAX_UNSEEN_NAMES + 1);
    expect(names).toContain("Zach");
    expect(names).toContain(`Ghost ${MAX_UNSEEN_NAMES + 99}`);
    expect(names).not.toContain("Ghost 99");
    expect((await join(jsonRequest(url, { name: "Lee" }), params({ slug }))).status).toBe(200);
  });

  it("refuses new agents, not people, while too many joins nobody can vouch for hold names", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const url = `http://localhost:3000/api/rooms/${slug}/join`;
    noteWebhook(db); // but it hasn't spoken of this meeting: anyone may be in it, unseen
    const anna = addParticipant(db, { slug, name: "Anna", isHost: false }, Date.now() - 2 * TOKEN_TTL_MS);
    const { code: real } = createAgentCode(db, anna);
    const insert = db.prepare(
      "INSERT INTO participants (identity, room_slug, name, is_host, secret_hash, created_at, expires_at) VALUES (?, ?, ?, 0, 's', ?, ?)",
    );
    db.exec("BEGIN");
    // First joined two hours ago (so they hold no place), last a moment ago.
    const long = Date.now() - 2 * TOKEN_TTL_MS;
    for (let i = 0; i < MAX_UNSEEN_NAMES; i++) insert.run(`p_ghost${i}`, slug, `Ghost ${i}`, long, Date.now() + SESSION_TTL_MS);
    db.exec("COMMIT");
    const res = await claim(jsonRequest("http://localhost/api/agent/claim", { code: real, name: "Ana" }));
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("names_busy");
    expect((db.prepare("SELECT attempts FROM agent_codes").get() as { attempts: number }).attempts).toBe(0);
    expect((await join(jsonRequest(url, { name: "Lee" }), params({ slug }))).status).toBe(200);
    // For a few seconds it doesn't look again: retries can't make it scan over and over.
    db.prepare("DELETE FROM participants WHERE identity LIKE 'p_ghost%'").run();
    expect((await claim(jsonRequest("http://localhost/api/agent/claim", { code: real, name: "Nova" }))).status).toBe(503);
    vi.setSystemTime(Date.now() + 11_000);
    expect((await claim(jsonRequest("http://localhost/api/agent/claim", { code: real, name: "Nova" }))).status).toBe(201);
  });

  it("counts a reload with new joins when it would make a name the webhook vouched for one it can't", async () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const url = `http://localhost:3000/api/rooms/${slug}/join`;
    noteWebhook(db);
    const joined: { name: string; identity: string; secret: string }[] = [];
    for (const name of ["Zach", "Mia"]) {
      const res = await join(jsonRequest(url, { name }), params({ slug }));
      const { identity } = (await res.json()) as { identity: string };
      joined.push({ name, identity, secret: setCookies(res)[`mooz_p_${slug}`] });
    }
    noteRoomWebhook(db, getRoom(db, slug)!.livekitRoom, Date.now() + 1); // spoken of since they joined
    notePersonPresence(db, joined[1].identity, "PA_mia", true); // Mia came in; Zach never did
    for (let i = 2; i < JOINS_PER_MINUTE; i++) await join(jsonRequest(url, { name: `Stranger ${i}` }), params({ slug }));
    const back = (p: (typeof joined)[number]) =>
      join(jsonRequest(url, { name: p.name, rejoin: p.identity }, { cookie: `mooz_p_${slug}=${p.secret}` }), params({ slug }));
    expect((await back(joined[0])).status).toBe(429);
    expect((await back(joined[1])).status).toBe(200);
  });

  it("keeps a reload on its own limit when the webhook hasn't spoken of the meeting since that join", async () => {
    const db = getDb();
    const hourAgo = Date.now() - 60 * 60 * 1000;
    noteWebhook(db, hourAgo); // still counts as arriving, but has gone quiet (an outage, say)
    for (const heard of [true, false]) {
      const { slug } = createRoom(db);
      if (heard) noteRoomWebhook(db, getRoom(db, slug)!.livekitRoom, hourAgo);
      const url = `http://localhost:3000/api/rooms/${slug}/join`;
      const res = await join(jsonRequest(url, { name: "Zach" }), params({ slug }));
      const { identity } = (await res.json()) as { identity: string };
      const secret = setCookies(res)[`mooz_p_${slug}`];
      for (let i = 1; i < JOINS_PER_MINUTE; i++) await join(jsonRequest(url, { name: `Stranger ${i}` }), params({ slug }));
      const back = await join(
        jsonRequest(url, { name: "Zach", rejoin: identity }, { cookie: `mooz_p_${slug}=${secret}` }),
        params({ slug }),
      );
      expect(back.status).toBe(200); // his name was one it couldn't vouch for already
    }
  });

  it("lets the host past a full meeting, though not without end", () => {
    const db = getDb();
    const { slug } = createRoom(db);
    const insert = db.prepare(
      "INSERT INTO participants (identity, room_slug, name, is_host, secret_hash, created_at, expires_at) VALUES (?, ?, 'Ghost', 0, 's', ?, ?)",
    );
    db.exec("BEGIN");
    for (let i = 0; i < MAX_ROOM_SESSIONS + HOST_SESSIONS - 1; i++) insert.run(`p_ghost${i}`, slug, Date.now(), Date.now() + 60_000);
    db.exec("COMMIT");
    expect(() => addParticipant(db, { slug, name: "Lee", isHost: false })).toThrow("full");
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
