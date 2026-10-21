import { expect, type Page } from "@playwright/test";
import {
  agentChat,
  assistant,
  bringAndApprove,
  call,
  closeAssistants,
  createConnector,
  openConnectorDoor,
  watchForErrors,
} from "./connector";
import { guestPage, joinAs, startMeeting, test } from "./fixtures";

test.afterEach(closeAssistants);

const SERVER = "http://127.0.0.1:3900/v1";

interface Seen {
  origins: Set<string>;
  authorization: string[];
  models: number;
  spoken: { model: string; input: string; voice: string; response_format: string }[];
  transcriptions: string[];
}

/** A speech server on the owner's computer (VoiceStudio), faked at the network edge. */
async function fakeSpeechServer(page: Page, origin: string): Promise<Seen> {
  const seen: Seen = { origins: new Set(), authorization: [], models: 0, spoken: [], transcriptions: [] };
  const cors = {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  await page.route(`${SERVER}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const headers = req.headers();
    if (headers.origin) seen.origins.add(headers.origin);
    if (headers.authorization) seen.authorization.push(headers.authorization);
    const path = new URL(req.url()).pathname;
    if (path === "/v1/models") {
      seen.models += 1;
      return route.fulfill({ status: 200, headers: cors, json: { data: [{ id: "whisper-1" }, { id: "tts-1" }] } });
    }
    if (path === "/v1/audio/speech") {
      seen.spoken.push(JSON.parse(req.postData() ?? "{}") as Seen["spoken"][number]);
      // A tenth of a second of quiet, as 24 kHz 16-bit PCM.
      return route.fulfill({ status: 200, headers: cors, contentType: "application/octet-stream", body: Buffer.alloc(4800) });
    }
    if (path === "/v1/audio/transcriptions") {
      const body = req.postDataBuffer()?.toString("latin1") ?? "";
      seen.transcriptions.push(`${headers["content-type"]}\n${body}`);
      // Somebody's (fake) microphone is on: "hear" them ask, once.
      const text = seen.transcriptions.length === 1 ? "Hey Grok, when is the launch?" : "";
      return route.fulfill({ status: 200, headers: cors, json: { text } });
    }
    return route.fulfill({ status: 404, headers: cors, body: "Not Found" });
  });
  return seen;
}

test("with a speech server on the owner's computer, the agent hears its name said out loud and speaks", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const errors = watchForErrors(page);
  const origin = new URL(baseURL!).origin;
  const speech = await fakeSpeechServer(page, origin);
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");

  // Kainoa picks the local server (at its usual address) and a voice; saving checks it's there.
  const url = await createConnector(page, "Grok");
  await page.getByTestId("voice-provider-local").check();
  await page.getByTestId("voice-local-voice").fill("af_bella");
  await page.getByTestId("voice-save").click();
  await expect(page.getByTestId("voice-status")).toContainText("Voice is on");
  await expect(page.getByTestId("voice-status")).toContainText(`speech server on this computer (${SERVER}, voice af_bella)`);
  expect(speech.models).toBe(1);
  await bringAndApprove(page, page, "Kainoa's Grok");
  await expect(page.getByTestId("connector-voice")).toContainText("hears its name and speaks, through the speech server on this computer");

  // Zach says "Hey Grok, …": his speech goes to Kainoa's server, one utterance as a WAV.
  const card = page.getByTestId("connector-question");
  await expect(card.getByTestId("connector-question-text")).toHaveText("when is the launch?", { timeout: 30_000 });
  const [first] = speech.transcriptions;
  expect(first).toMatch(/^multipart\/form-data; boundary=/);
  expect(first).toContain('name="model"\r\n\r\nwhisper-1\r\n');
  expect(first).toContain('name="language"\r\n\r\nen\r\n');
  expect(first).toContain('name="response_format"\r\n\r\njson\r\n');
  expect(first).toMatch(/filename="speech\.wav"\r\nContent-Type: audio\/wav\r\n\r\nRIFF[\s\S]{4}WAVEfmt /);

  // It makes its stock phrases ahead of time, then answers out loud.
  await expect.poll(() => speech.spoken.map((s) => s.input), { timeout: 15_000 }).toEqual(
    expect.arrayContaining(["Yes?", "One sec, checking."]),
  );
  await page.context().route("https://grok.com/**", (route) => route.fulfill({ contentType: "text/html", body: "Grok" }));
  const [grokTab] = await Promise.all([page.waitForEvent("popup"), card.getByTestId("ask-assistant").click()]);
  await grokTab.close();
  const grok = await assistant(url);
  const id = (await card.getAttribute("data-question-id"))!;
  await expect.poll(() => call(grok, "get_question"), { timeout: 10_000 }).toContain(`question_id: ${id}`);
  await call(grok, "post_answer", { question_id: id, spoken: "March 30th." });
  await expect(agentChat(zach).last().getByTestId("chat-text")).toHaveText("March 30th.", { timeout: 15_000 });
  await expect.poll(() => speech.spoken.map((s) => s.input), { timeout: 15_000 }).toContain("March 30th.");
  expect(speech.spoken.find((s) => s.input === "March 30th.")).toEqual({
    model: "tts-1",
    input: "March 30th.",
    voice: "af_bella",
    response_format: "pcm",
  });
  await expect(zach.locator('[data-testid="participant-tile"][data-kind="agent"]')).toHaveAttribute("data-mic", "on", {
    timeout: 15_000,
  });

  // Only Kainoa's tab talked to the server, and it never sent a key.
  expect([...speech.origins]).toEqual([origin]);
  expect(speech.authorization).toEqual([]);

  // Turning voice off goes back to chat only.
  await openConnectorDoor(page);
  await page.getByTestId("voice-forget").click();
  await expect(page.getByTestId("voice-provider-elevenlabs")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("connector-voice")).toContainText("Chat only");
  expect(errors).toEqual([]);
});

test("saving says what's wrong with a speech server that's missing or doesn't allow the page", async ({ page }) => {
  const errors = watchForErrors(page);
  await startMeeting(page);
  await joinAs(page, "Kainoa");
  await openConnectorDoor(page);
  await page.getByTestId("voice-provider-local").check();

  // Nothing listens on this port.
  await page.getByTestId("voice-local-url").fill("http://127.0.0.1:3999/v1");
  await page.getByTestId("voice-save").click();
  await expect(page.getByTestId("voice-error")).toContainText("Can't reach your speech server at http://127.0.0.1:3999/v1. Is it running?");

  // This one answers, but lets in only some other page. (Without any CORS header, Playwright adds one.)
  await page.route("http://127.0.0.1:3901/**", (route) =>
    route.fulfill({ status: 200, headers: { "access-control-allow-origin": "http://elsewhere.test" }, json: { data: [] } }),
  );
  await page.getByTestId("voice-local-url").fill("http://127.0.0.1:3901/v1");
  await page.getByTestId("voice-save").click();
  await expect(page.getByTestId("voice-error")).toContainText("OMNIVOICE_ALLOWED_ORIGINS");
  await expect(page.getByTestId("voice-provider-local")).toBeChecked();

  // Anything off this computer is refused before a request is made.
  await page.getByTestId("voice-local-url").fill("http://192.168.1.5:3900/v1");
  await page.getByTestId("voice-save").click();
  await expect(page.getByTestId("voice-error")).toContainText("Use a speech server on this computer");
  // Failed fetches log to the console; none of it is the page's policy refusing them.
  expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([]);
});
