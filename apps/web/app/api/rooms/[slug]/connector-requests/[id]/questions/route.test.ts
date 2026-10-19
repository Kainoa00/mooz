import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideAgentRequest } from "@/lib/agents";
import { connectorAgentFor, requestConnectorJoin } from "@/lib/connector-agents";
import { CONNECTOR_TOPIC } from "@/lib/connector-protocol";
import { getQuestion, listQuestions, resetQueueForTests } from "@/lib/connector-queue";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { OWNER_COOKIE, createConnector } from "@/lib/connectors";
import { getDb } from "@/lib/db";
import { addParticipant, createRoom, getRoom } from "@/lib/rooms";
import { jsonRequest, params, useTestEnv } from "@/test/helpers";

const sent: { room: string; identity: string; topic: string; message: unknown }[] = [];
vi.mock("@/lib/livekit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/livekit")>()),
  sendToParticipant: async (room: string, identity: string, topic: string, message: unknown) => {
    sent.push({ room, identity, topic, message });
  },
  removeFromRoom: async () => {},
}));

const { GET, POST } = await import("./route");
const { POST: ANSWER } = await import("./[qid]/answer/route");
const { POST: RELEASE } = await import("./[qid]/release/route");
const { DELETE: DISMISS } = await import("./[qid]/route");
const { DELETE: WITHDRAW } = await import("../route");
const { POST: REMOVE } = await import("@/app/api/rooms/[slug]/agents/[identity]/remove/route");

beforeEach(() => {
  useTestEnv();
  resetQueueForTests();
  resetRateLimitsForTests();
  sent.length = 0;
});

function setup() {
  const db = getDb();
  const { slug, hostSecret } = createRoom(db);
  const kai = addParticipant(db, { slug, name: "Kainoa", isHost: true });
  const zach = addParticipant(db, { slug, name: "Zach", isHost: false });
  const { connector } = createConnector(db, "kai-key", { name: "Grok", app: "grok" });
  const { requestId } = requestConnectorJoin(db, kai, "kai-key", connector.id);
  decideAgentRequest(db, { slug, requestId, approve: true });
  const agent = connectorAgentFor(db, kai, "kai-key", requestId);
  const cookie = `mooz_p_${slug}=${kai.secret}; ${OWNER_COOKIE}=kai-key; mooz_host_${slug}=${hostSecret}`;
  const url = `http://localhost/api/rooms/${slug}/connector-requests/${requestId}/questions`;
  return { db, slug, kai, zach, requestId, agent, cookie, url };
}

describe("/api/rooms/[slug]/connector-requests/[id]/questions", () => {
  it("queues a question the owner's tab heard, and lists it back", async () => {
    const { slug, zach, requestId, agent, cookie, url } = setup();

    const res = await POST(
      jsonRequest(url, { asker: zach.identity, text: "@Grok when is the launch?", lines: [] }, { cookie }),
      params({ slug, id: requestId }),
    );

    expect(res.status).toBe(201);
    const { question } = (await res.json()) as { question: { id: string; text: string } };
    expect(question.text).toBe("@Grok when is the launch?");
    // The assistant sees it only once the owner taps.
    expect(getQuestion(getDb(), agent, question.id)).toBeUndefined();
    const tapped = await RELEASE(
      new Request(`${url}/${question.id}/release`, { method: "POST", headers: { cookie } }),
      params({ slug, id: requestId, qid: question.id }),
    );
    expect(tapped.status).toBe(200);
    expect(getQuestion(getDb(), agent, question.id)?.question.text).toBe("@Grok when is the launch?");

    const listed = await GET(new Request(url, { headers: { cookie } }), params({ slug, id: requestId }));
    expect(((await listed.json()) as { questions: { id: string }[] }).questions.map((q) => q.id)).toEqual([question.id]);
  });

  it("is only for the owner's tab, with the owner key its connector belongs to", async () => {
    const { slug, kai, zach, requestId, url } = setup();
    const body = { asker: zach.identity, text: "hi", lines: [] };
    const wrongKey = await POST(
      jsonRequest(url, body, { cookie: `mooz_p_${slug}=${kai.secret}; ${OWNER_COOKIE}=someone-elses-key` }),
      params({ slug, id: requestId }),
    );
    expect(wrongKey.status).toBe(404);
    const asZach = await POST(
      jsonRequest(url, body, { cookie: `mooz_p_${slug}=${zach.secret}; ${OWNER_COOKIE}=zach-key` }),
      params({ slug, id: requestId }),
    );
    expect(asZach.status).toBe(404);
    const crossSite = await POST(
      jsonRequest(url, body, { "sec-fetch-site": "cross-site" }),
      params({ slug, id: requestId }),
    );
    expect(crossSite.status).toBe(403);
  });

  it("delivers an answer the owner pastes to the agent alone", async () => {
    const { db, slug, zach, requestId, agent, cookie, url } = setup();
    const { question } = (await (
      await POST(jsonRequest(url, { asker: zach.identity, text: "q", lines: [] }, { cookie }), params({ slug, id: requestId }))
    ).json()) as { question: { id: string } };

    const res = await ANSWER(
      jsonRequest(`${url}/${question.id}/answer`, { spoken: "Next Tuesday.", details: "From the plan." }, { cookie }),
      params({ slug, id: requestId, qid: question.id }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: true });
    expect(sent).toEqual([
      {
        room: getRoom(db, slug)!.livekitRoom,
        identity: agent.identity,
        topic: CONNECTOR_TOPIC,
        message: expect.objectContaining({ type: "answer", id: question.id, spoken: "Next Tuesday.", reply_to: zach.identity }),
      },
    ]);
    const again = await ANSWER(
      jsonRequest(`${url}/${question.id}/answer`, { spoken: "Again." }, { cookie }),
      params({ slug, id: requestId, qid: question.id }),
    );
    expect(again.status).toBe(409);
  });

  it("drops the agent's questions when the host removes it", async () => {
    const { slug, zach, requestId, agent, cookie, url } = setup();
    await POST(jsonRequest(url, { asker: zach.identity, text: "q", lines: [] }, { cookie }), params({ slug, id: requestId }));

    const res = await REMOVE(
      new Request(`http://localhost/api/rooms/${slug}/agents/${agent.identity}/remove`, { method: "POST", headers: { cookie } }),
      params({ slug, identity: agent.identity }),
    );

    expect(res.status).toBe(200);
    expect(listQuestions(agent.identity)).toEqual([]);
  });
});

describe("the owner's controls", () => {
  it("dismisses a question for good", async () => {
    const { slug, zach, requestId, agent, cookie, url } = setup();
    const { question } = (await (
      await POST(jsonRequest(url, { asker: zach.identity, text: "q", lines: [] }, { cookie }), params({ slug, id: requestId }))
    ).json()) as { question: { id: string } };
    const res = await DISMISS(
      new Request(`${url}/${question.id}`, { method: "DELETE", headers: { cookie } }),
      params({ slug, id: requestId, qid: question.id }),
    );
    expect(res.status).toBe(200);
    expect(listQuestions(agent.identity)).toEqual([]);
    const tooLate = await RELEASE(
      new Request(`${url}/${question.id}/release`, { method: "POST", headers: { cookie } }),
      params({ slug, id: requestId, qid: question.id }),
    );
    expect(tooLate.status).toBe(404);
  });

  it("takes the agent out of the meeting", async () => {
    const { slug, zach, requestId, agent, cookie, url } = setup();
    await POST(jsonRequest(url, { asker: zach.identity, text: "q", lines: [] }, { cookie }), params({ slug, id: requestId }));
    const res = await WITHDRAW(
      new Request(url.replace(/\/questions$/, ""), { method: "DELETE", headers: { cookie } }),
      params({ slug, id: requestId }),
    );
    expect(res.status).toBe(200);
    expect(listQuestions(agent.identity)).toEqual([]);
    const after = await POST(jsonRequest(url, { asker: zach.identity, text: "q", lines: [] }, { cookie }), params({ slug, id: requestId }));
    expect(after.status).toBe(409);
  });

  it("refuses a flood of questions or an oversized one", async () => {
    const { slug, zach, requestId, cookie, url } = setup();
    const big = await POST(
      jsonRequest(url, { asker: zach.identity, text: "q", lines: [{ identity: zach.identity, text: "x".repeat(300_000) }] }, { cookie }),
      params({ slug, id: requestId }),
    );
    expect(big.status).toBe(413);
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await POST(jsonRequest(url, { asker: zach.identity, text: `q${i}`, lines: [] }, { cookie }), params({ slug, id: requestId }));
      statuses.push(res.status);
    }
    // The oversized one counted too: requests are counted before their bodies are read.
    expect(statuses.slice(0, 19).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(19).every((s) => s === 429)).toBe(true);
  });
});

describe("when LiveKit can't take the answer", () => {
  it("keeps it with the question for the owner's tab to pick up", async () => {
    const { slug, zach, requestId, cookie, url } = setup();
    const { question } = (await (
      await POST(jsonRequest(url, { asker: zach.identity, text: "q", lines: [] }, { cookie }), params({ slug, id: requestId }))
    ).json()) as { question: { id: string } };
    const livekit = await import("@/lib/livekit");
    const spy = vi.spyOn(livekit, "sendToParticipant").mockRejectedValueOnce(new Error("not connected"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await ANSWER(
      jsonRequest(`${url}/${question.id}/answer`, { spoken: "Tuesday." }, { cookie }),
      params({ slug, id: requestId, qid: question.id }),
    );

    expect(await res.json()).toEqual({ ok: true, delivered: false });
    const listed = (await (await GET(new Request(url, { headers: { cookie } }), params({ slug, id: requestId }))).json()) as {
      questions: { answer?: { spoken: string } }[];
    };
    expect(listed.questions[0].answer?.spoken).toBe("Tuesday.");
    spy.mockRestore();
    errors.mockRestore();
  });
});
