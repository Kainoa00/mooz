import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_TURN_MS,
  continueAgents,
  endFloor,
  endTurn,
  FLOOR_IDLE_MS,
  floorView,
  getTurn,
  leaveFloor,
  leaveFloors,
  MAX_AGENT_STREAK,
  MAX_OPEN_TURNS,
  MAX_WAITERS,
  requestTurn,
  resetFloorsForTests,
  setFloorListener,
  SPEAKING_TURN_MS,
  waitForTurn,
  WAITING_TTL_MS,
  type Answering,
} from "./floor";

const ROOM = "abc-defg-hij";
const ask = (agent: string, answering: Answering = "person", speak = true) =>
  requestTurn(ROOM, agent, { answering, speak });
const status = (agent: string, id: string) => getTurn(ROOM, agent, id).status;

beforeEach(() => {
  vi.useFakeTimers();
  resetFloorsForTests();
});
afterEach(() => {
  setFloorListener(undefined);
  vi.useRealTimers();
});

describe("taking turns", () => {
  it("grants a free floor at once, and one turn at a time, first come first served", () => {
    const atlas = ask("atlas");
    const nova = ask("nova");
    const grok = ask("grok");
    expect(atlas).toMatchObject({ status: "granted", endsAt: Date.now() + SPEAKING_TURN_MS });
    expect([nova.status, grok.status]).toEqual(["waiting", "waiting"]);
    expect(floorView(ROOM)).toEqual({ speaking: "atlas", next: "nova", paused: false, continued: 0 });

    expect(endTurn(ROOM, "atlas", atlas.id)).toMatchObject({ status: "ended", reason: "done" });
    expect([status("nova", nova.id), status("grok", grok.id)]).toEqual(["granted", "waiting"]);
    endTurn(ROOM, "nova", nova.id);
    expect(status("grok", grok.id)).toBe("granted");
    endTurn(ROOM, "grok", grok.id);
    expect(floorView(ROOM)).toEqual({ speaking: null, next: null, paused: false, continued: 0 });
  });

  it("puts answers to people ahead of replies to agents", () => {
    const first = ask("atlas", "agent");
    const reply = ask("nova", "agent");
    const answer = ask("grok", "person");
    expect(floorView(ROOM).next).toBe("grok");
    endTurn(ROOM, "atlas", first.id);
    expect([status("grok", answer.id), status("nova", reply.id)]).toEqual(["granted", "waiting"]);
  });

  it("ends a turn that runs too long and passes the floor on, with no one asking", async () => {
    const changes: string[] = [];
    setFloorListener((slug) => changes.push(slug));
    const atlas = ask("atlas");
    const nova = ask("nova", "person", false);
    const poll = waitForTurn(ROOM, "nova", nova.id, 60_000);
    changes.length = 0;
    vi.advanceTimersByTime(SPEAKING_TURN_MS);
    await expect(poll).resolves.toMatchObject({ status: "granted" });
    expect(getTurn(ROOM, "atlas", atlas.id)).toMatchObject({ status: "ended", reason: "timeout" });
    expect(getTurn(ROOM, "nova", nova.id)).toMatchObject({ status: "granted", endsAt: Date.now() + CHAT_TURN_MS });
    expect(changes).toEqual([ROOM]);
    vi.advanceTimersByTime(CHAT_TURN_MS);
    expect(getTurn(ROOM, "nova", nova.id)).toMatchObject({ status: "ended", reason: "timeout" });
  });

  it("drops a waiting turn whose agent stopped asking, but not one still checking or waiting on a poll", async () => {
    ask("atlas");
    const nova = ask("nova");
    const grok = ask("grok");
    const lee = ask("lee");
    const polling = waitForTurn(ROOM, "lee", lee.id, 35_000);
    vi.advanceTimersByTime(WAITING_TTL_MS - 1);
    getTurn(ROOM, "grok", grok.id); // still there
    vi.advanceTimersByTime(1);
    expect(getTurn(ROOM, "nova", nova.id)).toMatchObject({ status: "ended", reason: "expired" });
    expect(status("grok", grok.id)).toBe("waiting");
    vi.advanceTimersByTime(WAITING_TTL_MS * 3); // 40 s: Atlas still has the floor
    expect(status("grok", grok.id)).toBe("ended");
    expect(status("lee", lee.id)).toBe("waiting"); // its poll ran until 35 s
    await expect(polling).resolves.toMatchObject({ status: "waiting" });
  });

  it("answers a waiting poll the moment its turn comes", async () => {
    const atlas = ask("atlas");
    const nova = ask("nova");
    const poll = waitForTurn(ROOM, "nova", nova.id, 25_000);
    endTurn(ROOM, "atlas", atlas.id);
    await expect(poll).resolves.toMatchObject({ status: "granted" });
    await expect(waitForTurn(ROOM, "nova", nova.id, 25_000)).resolves.toMatchObject({ status: "granted" });
  });

  it("stops a poll when the request goes away", async () => {
    ask("atlas");
    const nova = ask("nova");
    const abort = new AbortController();
    const poll = waitForTurn(ROOM, "nova", nova.id, 25_000, abort.signal);
    abort.abort();
    await expect(poll).resolves.toMatchObject({ status: "waiting" });
    vi.advanceTimersByTime(WAITING_TTL_MS);
    expect(status("nova", nova.id)).toBe("ended"); // no longer anyone waiting on it
  });

  it("frees the floor when an agent leaves, and forgets the turns it was waiting for", () => {
    const atlas = ask("atlas");
    const nova = ask("nova");
    const grok = ask("grok");
    leaveFloor(ROOM, "nova");
    leaveFloor(ROOM, "atlas");
    expect(getTurn(ROOM, "atlas", atlas.id)).toMatchObject({ status: "ended", reason: "left" });
    expect(status("nova", nova.id)).toBe("ended");
    expect(status("grok", grok.id)).toBe("granted");
    leaveFloor("no-such-room", "atlas");
  });

  it("frees every floor an agent was on when it's taken out", () => {
    const here = ask("atlas");
    const there = requestTurn("other-room", "atlas", { answering: "person", speak: true });
    leaveFloors("atlas");
    expect(status("atlas", here.id)).toBe("ended");
    expect(getTurn("other-room", "atlas", there.id).status).toBe("ended");
  });

  it("doesn't give one agent turn after turn while another waits", () => {
    // Asking again replaces a granted turn, but the new one goes behind whoever is waiting.
    ask("liar", "person");
    const nova = ask("nova", "agent");
    for (let i = 0; i < 3; i++) ask("liar", "person");
    expect(status("nova", nova.id)).toBe("granted");
  });

  it("lets only so many checks wait on one turn", () => {
    ask("atlas");
    const nova = ask("nova");
    for (let i = 0; i < MAX_WAITERS; i++) void waitForTurn(ROOM, "nova", nova.id, 1000);
    expect(() => waitForTurn(ROOM, "nova", nova.id, 1000)).toThrowError(
      expect.objectContaining({ status: 429, code: "too_many_checks" }),
    );
  });

  it("keeps one open turn of each kind per agent: asking again replaces the last", () => {
    const first = ask("atlas");
    const nova = ask("nova");
    const again = ask("atlas");
    expect(getTurn(ROOM, "atlas", first.id)).toMatchObject({ status: "ended", reason: "replaced" });
    expect(status("nova", nova.id)).toBe("granted");
    expect(again.status).toBe("waiting");
    const reply = ask("atlas", "agent");
    expect([status("atlas", again.id), reply.status]).toEqual(["waiting", "waiting"]);
  });

  it("lets an agent answer a person while its reply to an agent is held", () => {
    for (let i = 0; i < MAX_AGENT_STREAK; i++) endTurn(ROOM, "atlas", ask("atlas", "agent").id);
    const held = ask("atlas", "agent");
    const answer = ask("atlas", "person");
    expect([held.status, answer.status]).toEqual(["held", "granted"]);
  });

  it("lets an agent withdraw a turn it is waiting for", () => {
    ask("atlas");
    const nova = ask("nova");
    expect(endTurn(ROOM, "nova", nova.id)).toMatchObject({ status: "ended", reason: "done" });
    expect(endTurn(ROOM, "nova", nova.id)).toMatchObject({ status: "ended", reason: "done" });
  });

  it("only shows an agent its own turns", () => {
    const atlas = ask("atlas");
    for (const call of [
      () => getTurn(ROOM, "nova", atlas.id),
      () => endTurn(ROOM, "nova", atlas.id),
      () => waitForTurn(ROOM, "nova", atlas.id, 1000),
      () => getTurn(ROOM, "atlas", "t_nope"),
      () => getTurn("no-such-room", "atlas", atlas.id),
    ]) {
      expect(call).toThrowError(expect.objectContaining({ status: 404, code: "turn_not_found" }));
    }
    expect(status("atlas", atlas.id)).toBe("granted");
  });

  it("has room for only so many waiting turns", () => {
    for (let i = 0; i < MAX_OPEN_TURNS; i++) ask(`agent-${i}`);
    expect(() => ask("one-more")).toThrowError(expect.objectContaining({ status: 429, code: "floor_busy" }));
  });

  it("forgets a finished turn after a while, and a quiet floor (its count too) after longer", () => {
    for (let i = 0; i < MAX_AGENT_STREAK; i++) endTurn(ROOM, "atlas", ask("atlas", "agent").id);
    const last = ask("atlas", "person");
    endTurn(ROOM, "atlas", last.id);
    vi.advanceTimersByTime(60_000);
    expect(() => getTurn(ROOM, "atlas", last.id)).toThrow();
    for (let i = 0; i < MAX_AGENT_STREAK; i++) endTurn(ROOM, "atlas", ask("atlas", "agent").id);
    vi.advanceTimersByTime(FLOOR_IDLE_MS);
    expect(ask("nova", "agent").status).toBe("granted"); // not held: a new floor
  });

  it("ends every turn when the meeting ends", async () => {
    ask("atlas");
    const nova = ask("nova");
    const poll = waitForTurn(ROOM, "nova", nova.id, 25_000);
    endFloor(ROOM);
    await expect(poll).resolves.toMatchObject({ status: "ended", reason: "meeting_ended" });
    expect(floorView(ROOM)).toEqual({ speaking: null, next: null, paused: false, continued: 0 });
    endFloor(ROOM);
  });
});

describe("pausing agents that keep talking to each other", () => {
  /** One agent turn, start to finish. */
  function turn(agent: string, answering: Answering) {
    const t = ask(agent, answering);
    if (t.status === "granted") endTurn(ROOM, agent, t.id);
    return t;
  }

  it(`holds the reply after ${MAX_AGENT_STREAK} agent-to-agent turns until a person lets them continue`, () => {
    const changes: string[] = [];
    setFloorListener((slug) => changes.push(slug));
    turn("atlas", "person");
    for (let i = 0; i < MAX_AGENT_STREAK; i++) expect(turn(i % 2 ? "atlas" : "nova", "agent").status).toBe("granted");
    changes.length = 0;
    const held = ask("atlas", "agent");
    expect(held.status).toBe("held");
    expect(floorView(ROOM)).toEqual({ speaking: null, next: null, paused: true, continued: 0 });
    expect(changes).toEqual([ROOM]);

    // Answers to people still go out while paused, and the reply stays held.
    expect(turn("nova", "person").status).toBe("granted");
    expect(status("atlas", held.id)).toBe("held");
    expect(ask("grok", "agent").status).toBe("held");

    expect(continueAgents(ROOM)).toBe(true);
    expect(status("atlas", held.id)).toBe("granted");
    expect(floorView(ROOM)).toEqual({ speaking: "atlas", next: "grok", paused: false, continued: expect.any(Number) });
  });

  it("says when a person let the agents continue, and nothing else changes that", () => {
    for (let i = 0; i < MAX_AGENT_STREAK; i++) turn(i % 2 ? "atlas" : "nova", "agent");
    const held = ask("atlas", "agent");
    expect(floorView(ROOM)).toMatchObject({ paused: true, continued: 0 });

    // The held reply going away hides the pause, but it isn't a Continue.
    endTurn(ROOM, "atlas", held.id);
    expect(floorView(ROOM)).toMatchObject({ paused: false, continued: 0 });
    const again = ask("nova", "agent");
    expect(again.status).toBe("held");

    expect(continueAgents(ROOM)).toBe(true);
    const first = floorView(ROOM).continued;
    expect(first).toBeGreaterThan(0);
    endTurn(ROOM, "nova", again.id);
    turn("atlas", "agent");
    turn("grok", "agent");
    expect(ask("atlas", "agent").status).toBe("held");
    expect(continueAgents(ROOM)).toBe(true);
    expect(floorView(ROOM).continued).toBeGreaterThan(first);
  });

  it("lets a paused agent's own replies go again after Continue (its count starts over too)", () => {
    // Nova replies to agents three times; people's answers between keep the meeting's count low.
    for (const [agent, answering] of [
      ["nova", "agent"],
      ["zed", "person"],
      ["nova", "agent"],
      ["zed", "person"],
      ["nova", "agent"],
    ] as const) {
      expect(turn(agent, answering).status).toBe("granted");
    }
    const held = ask("nova", "agent");
    expect(held.status).toBe("held");

    expect(continueAgents(ROOM)).toBe(true);
    expect(status("nova", held.id)).toBe("granted");
    endTurn(ROOM, "nova", held.id);
    expect(turn("nova", "agent").status).toBe("granted");
  });

  it("gives the floor to another agent's reply, not the last speaker's, whichever asked first", () => {
    const atlasAnswer = ask("atlas", "person");
    expect(atlasAnswer.status).toBe("granted");
    const atlasReply = ask("atlas", "agent");
    const novaReply = ask("nova", "agent");
    endTurn(ROOM, "atlas", atlasAnswer.id);
    expect(status("nova", novaReply.id)).toBe("granted");
    expect(status("atlas", atlasReply.id)).toBe("waiting");
  });

  it("counts again from zero after Continue, so the exchange pauses again", () => {
    for (let i = 0; i < MAX_AGENT_STREAK; i++) turn("atlas", "agent");
    const held = ask("nova", "agent");
    continueAgents(ROOM);
    endTurn(ROOM, "nova", held.id); // the released reply: 1
    turn("atlas", "agent"); // 2
    turn("nova", "agent"); // 3
    expect(ask("atlas", "agent").status).toBe("held");
  });

  it("starts the count over when an agent answers a person", () => {
    turn("atlas", "agent");
    turn("nova", "agent");
    turn("atlas", "person");
    for (const agent of ["grok", "lee", "grok"]) expect(turn(agent, "agent").status).toBe("granted");
    expect(ask("atlas", "agent").status).toBe("held");
  });

  it("holds an agent that keeps replying to agents, however often another claims to answer people", () => {
    // Liar says every turn answers a person (which resets the meeting's count); Nova, honestly,
    // replies to it. Nova gets its run, then waits for a person.
    for (let i = 0; i < MAX_AGENT_STREAK; i++) {
      turn("liar", "person");
      expect(turn("nova", "agent").status).toBe("granted");
    }
    turn("liar", "person");
    expect(ask("nova", "agent").status).toBe("held");
    expect(floorView(ROOM).paused).toBe(true);
    // Answering a person starts Nova's own count over, and so does Continue.
    expect(continueAgents(ROOM)).toBe(true);
  });

  it("starts an agent's own count over when it answers a person", () => {
    for (let i = 0; i < MAX_AGENT_STREAK - 1; i++) {
      turn("liar", "person");
      turn("nova", "agent");
    }
    turn("nova", "person");
    for (let i = 0; i < MAX_AGENT_STREAK - 1; i++) {
      turn("liar", "person");
      expect(turn("nova", "agent").status).toBe("granted");
    }
  });

  it("holds a reply already waiting when the pause starts", () => {
    for (let i = 0; i < MAX_AGENT_STREAK - 1; i++) turn("atlas", "agent");
    const third = ask("nova", "agent");
    const fourth = ask("atlas", "agent");
    expect(fourth.status).toBe("waiting");
    endTurn(ROOM, "nova", third.id);
    expect(status("atlas", fourth.id)).toBe("held");
  });

  it("has nothing to continue when nothing is held, and stays paused if the held reply gives up", () => {
    expect(continueAgents(ROOM)).toBe(false);
    for (let i = 0; i < MAX_AGENT_STREAK; i++) turn("atlas", "agent");
    const held = ask("nova", "agent");
    vi.advanceTimersByTime(WAITING_TTL_MS);
    expect(status("nova", held.id)).toBe("ended");
    expect(floorView(ROOM).paused).toBe(false); // nothing to show a Continue for
    expect(continueAgents(ROOM)).toBe(false);
    expect(ask("nova", "agent").status).toBe("held"); // the next reply is still held
    expect(floorView(ROOM).paused).toBe(true);
  });

  it("tells a held agent's poll that it was let go", async () => {
    for (let i = 0; i < MAX_AGENT_STREAK; i++) turn("atlas", "agent");
    const held = ask("nova", "agent");
    const poll = waitForTurn(ROOM, "nova", held.id, 25_000);
    vi.advanceTimersByTime(20_000);
    expect(status("nova", held.id)).toBe("held"); // waiting on a poll keeps it
    continueAgents(ROOM);
    await expect(poll).resolves.toMatchObject({ status: "granted" });
  });
});
