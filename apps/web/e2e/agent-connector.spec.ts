import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, type Page } from "@playwright/test";
import { assistantPrompt } from "../lib/connector-protocol";
import { guestPage, joinAs, sendChat, startMeeting, test } from "./fixtures";

const ELEVENLABS_KEY = "sk_e2e_0123456789abcdef";

/** The owner's assistant app, played by a script: an MCP client on the connector link. */
async function assistant(url: string): Promise<Client> {
  const client = new Client({ name: "e2e-assistant", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[] };
  return result.content.map((c) => c.text).join("\n");
}

async function openConnectorDoor(owner: Page): Promise<void> {
  await owner.getByRole("button", { name: "Bring my agent" }).click();
  await owner.getByRole("tab", { name: "Grok, Claude or ChatGPT" }).click();
}

/** Makes a connector in the dialog (left open) and returns its link. */
async function createConnector(owner: Page, name: string): Promise<string> {
  await openConnectorDoor(owner);
  await owner.getByTestId("connector-name").fill(name);
  await owner.getByTestId("connector-app").selectOption("grok");
  await owner.getByTestId("connector-create").click();
  return (await owner.getByTestId("connector-url").textContent())!.trim();
}

/** Brings the connector in (from the open dialog) and lets it in as the host. */
async function bringAndApprove(host: Page, owner: Page, label: string): Promise<void> {
  await owner.getByTestId("connector-bring").click(); // closes the dialog
  await expect(host.getByTestId("agent-request")).toContainText(label, { timeout: 15_000 });
  await host.getByTestId("agent-request").getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByTestId("connector-panel")).toHaveAttribute("data-phase", "in", { timeout: 30_000 });
}

const agentChat = (p: Page) => p.locator('[data-testid="chat-message"][data-kind="agent"]');

/** Everything the page would have refused under its CSP, or thrown. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("the owner brings Grok through a connector; it answers through the owner's assistant, minus opted-out words", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const errors = watchForErrors(page);
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");

  const url = await createConnector(page, "Grok");
  expect(url).toMatch(new RegExp(`^${baseURL}/mcp/[A-Za-z0-9_-]{40,}$`));
  const grok = await assistant(url);
  expect(await call(grok, "get_question")).toContain("Grok isn't in a mooz meeting right now");

  await bringAndApprove(page, page, "Kainoa's Grok");
  for (const p of [page, zach]) {
    const tile = p.locator('[data-testid="participant-tile"][data-kind="agent"]');
    await expect(tile).toHaveAttribute("data-label", "🤖 Kainoa's Grok", { timeout: 30_000 });
    // Everyone is told their words can reach Kainoa's assistant app, and can opt out.
    await expect(p.getByTestId("notes-banner-text")).toContainText("Kainoa's Grok can share what's said");
  }
  await expect(page.getByTestId("connector-voice")).toContainText("Chat only");

  await zach.getByRole("button", { name: "Leave me out" }).click();
  await expect(zach.getByTestId("notes-opted-out")).toBeVisible({ timeout: 10_000 });
  await sendChat(zach, "the codename is bluebird");
  await sendChat(page, "launch moved to March 30th");
  await expect(page.getByText("the codename is bluebird")).toBeVisible();

  // A guest asks; Grok says it's on it, and Kainoa gets a one-tap card for the Grok app.
  await sendChat(zach, "@Grok when is the launch?");
  const card = page.getByTestId("connector-question");
  await expect(card.getByTestId("connector-question-text")).toHaveText("when is the launch?", { timeout: 15_000 });
  await expect(card).toContainText("Zach asks");
  await expect(agentChat(zach).last().getByTestId("chat-text")).toHaveText("One sec, checking.");
  const id = (await card.getAttribute("data-question-id"))!;
  await expect(card.getByTestId("ask-assistant")).toHaveAttribute(
    "href",
    `https://grok.com/?q=${encodeURIComponent(assistantPrompt(id))}`,
  );

  // The assistant reads the question and the meeting (without Zach's words), then answers.
  const question = await call(grok, "get_question");
  expect(question).toContain(`question_id: ${id}`);
  expect(question).toContain("From: Zach (a guest, not Kainoa)");
  expect(question).toContain("[owner] Kainoa (chat): launch moved to March 30th");
  expect(question).not.toContain("bluebird");
  expect(await call(grok, "read_meeting")).not.toContain("bluebird");
  expect(await call(grok, "post_answer", { question_id: id, spoken: "March 30th.", details: "Moved from March 2nd." })).toMatch(
    /posted|said|answer/i,
  );

  const reply = agentChat(zach).last();
  await expect(reply.getByTestId("chat-text")).toContainText("March 30th.", { timeout: 15_000 });
  await expect(reply.getByTestId("chat-text")).toContainText("Moved from March 2nd.");
  await expect(reply.getByTestId("chat-sender")).toHaveText("🤖 Kainoa's Grok");
  await expect(card).toHaveCount(0);

  // A new link makes the old one dead.
  await openConnectorDoor(page);
  await page.getByRole("button", { name: "New link" }).click();
  await expect(page.getByTestId("connector-url")).not.toHaveText(url);
  const fresh = (await page.getByTestId("connector-url").textContent())!.trim();
  await page.getByRole("button", { name: "Done" }).click();
  const old = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: "{}",
  });
  expect(old.status).toBe(404);

  // The host removes it: the assistant can't reach the meeting anymore.
  const grokAgain = await assistant(fresh);
  await page.getByRole("button", { name: "Remove agent" }).click();
  await expect(page.getByTestId("connector-panel")).toHaveAttribute("data-phase", "removed", { timeout: 15_000 });
  await expect(zach.locator('[data-testid="participant-tile"][data-kind="agent"]')).toHaveCount(0, { timeout: 15_000 });
  expect(await call(grokAgain, "get_question")).toContain("isn't in a mooz meeting right now");
  expect(errors).toEqual([]);
});

/** ElevenLabs, faked at the network edge: tokens, Scribe realtime and speech. */
async function fakeElevenLabs(page: Page) {
  const seen = { tokenKeys: [] as string[], scribeUrls: [] as string[], spoken: [] as string[], ttsKeys: [] as string[] };
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "xi-api-key, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  await page.route("https://api.elevenlabs.io/v1/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = new URL(req.url()).pathname;
    if (path === "/v1/single-use-token/realtime_scribe") {
      seen.tokenKeys.push(req.headers()["xi-api-key"]);
      return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: '{"token":"sutkn_e2e"}' });
    }
    if (path.startsWith("/v1/text-to-speech/")) {
      seen.ttsKeys.push(req.headers()["xi-api-key"]);
      seen.spoken.push((JSON.parse(req.postData() ?? "{}") as { text: string }).text);
      // A tenth of a second of quiet, as 24 kHz 16-bit PCM.
      return route.fulfill({ status: 200, headers: cors, contentType: "application/octet-stream", body: Buffer.alloc(4800) });
    }
    return route.fulfill({ status: 404, headers: cors, body: "{}" });
  });
  let heard = false;
  await page.routeWebSocket(/^wss:\/\/api\.elevenlabs\.io\/v1\/speech-to-text\/realtime/, (ws) => {
    seen.scribeUrls.push(ws.url());
    ws.send(JSON.stringify({ message_type: "session_started", session_id: "e2e", config: {} }));
    ws.onMessage((message) => {
      const msg = JSON.parse(String(message)) as { message_type: string; audio_base_64: string };
      // Somebody's (fake) microphone is on: "hear" them ask, once.
      if (msg.message_type === "input_audio_chunk" && msg.audio_base_64 && !heard) {
        heard = true;
        ws.send(JSON.stringify({ message_type: "committed_transcript", text: "Hey Grok, when is the launch?" }));
      }
    });
  });
  return seen;
}

test("with the owner's ElevenLabs key, the agent hears its name said out loud and speaks its answer", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const errors = watchForErrors(page);
  const eleven = await fakeElevenLabs(page);
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");

  const url = await createConnector(page, "Grok");
  await page.getByTestId("voice-key").fill(ELEVENLABS_KEY);
  await page.getByTestId("voice-save").click();
  await expect(page.getByTestId("voice-status")).toContainText("Voice is on");
  await expect(page.getByTestId("voice-status")).toContainText("…cdef");
  await bringAndApprove(page, page, "Kainoa's Grok");
  await expect(page.getByTestId("connector-voice")).toContainText("hears its name and speaks");

  // Someone says "Hey Grok, …": transcribed through Kainoa's account, with a one-time token.
  const card = page.getByTestId("connector-question");
  await expect(card.getByTestId("connector-question-text")).toHaveText("when is the launch?", { timeout: 30_000 });
  expect(eleven.tokenKeys[0]).toBe(ELEVENLABS_KEY);
  const scribe = new URL(eleven.scribeUrls[0]);
  expect(scribe.searchParams.get("token")).toBe("sutkn_e2e");
  expect(scribe.searchParams.get("keyterms")).toBe("Grok");
  expect(scribe.toString()).not.toContain(ELEVENLABS_KEY);

  // It says it's on it, out loud, then speaks the answer the assistant posts.
  await expect.poll(() => eleven.spoken, { timeout: 15_000 }).toContain("One sec, checking.");
  const grok = await assistant(url);
  const id = (await card.getAttribute("data-question-id"))!;
  await call(grok, "post_answer", { question_id: id, spoken: "March 30th." });
  await expect(agentChat(zach).last().getByTestId("chat-text")).toHaveText("March 30th.", { timeout: 15_000 });
  await expect.poll(() => eleven.spoken, { timeout: 15_000 }).toContain("March 30th.");
  expect(new Set(eleven.ttsKeys)).toEqual(new Set([ELEVENLABS_KEY]));

  // Its voice is a real microphone track, which everyone receives.
  await expect(zach.locator('[data-testid="participant-tile"][data-kind="agent"]')).toHaveAttribute("data-mic", "on", {
    timeout: 15_000,
  });

  // Forgetting the key goes back to chat only.
  await openConnectorDoor(page);
  await page.getByTestId("voice-forget").click();
  await expect(page.getByTestId("voice-key")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("connector-voice")).toContainText("Chat only");
  expect(errors).toEqual([]);
});
