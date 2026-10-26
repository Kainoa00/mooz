import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { agentChat, assistant, bringAndApprove, call, closeAssistants, createConnector } from "./connector";
import { guestPage, joinAs, sendChat, startMeeting, test } from "./fixtures";

test.afterEach(closeAssistants);

test("an agent asked the moment it's let in still never shows as a person", async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");
  for (const p of [page, zach]) await expect(p.getByTestId("participant-tile")).toHaveCount(2);
  const url = await createConnector(page, "Grok");
  await bringAndApprove(page, page, "Kainoa's Grok");
  const grok = await assistant(url);

  // Asked right away, as a person would: before everyone's page has caught up with the agent.
  await sendChat(zach, "@Grok what's 2+2?");
  const card = page.getByTestId("connector-question");
  await expect(card.getByTestId("connector-question-text")).toHaveText("what's 2+2?", { timeout: 15_000 });
  const id = (await card.getAttribute("data-question-id"))!;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await card.getByTestId("copy-prompt").click();
  await expect(card.getByTestId("copy-prompt")).toHaveText("Copied"); // released to the assistant
  expect(await call(grok, "get_question")).toContain(`question_id: ${id}`);
  await call(grok, "post_answer", { question_id: id, spoken: "Four." });

  // Its "on it" and its answer are the agent's, on every page: never a guest's words.
  for (const p of [zach, page]) {
    await expect(agentChat(p).last().getByTestId("chat-text")).toContainText("Four.", { timeout: 15_000 });
    await expect(agentChat(p).getByTestId("chat-sender")).toHaveText(["🤖 Kainoa's Grok", "🤖 Kainoa's Grok"]);
    await expect(agentChat(p).getByTestId("chat-text")).toHaveText(["One sec, checking.", "Four."]);
    await expect(p.locator('[data-testid="chat-message"][data-kind="human"]')).toHaveText([/what's 2\+2\?/]);
  }

  // The host's summary has the answer as the agent's too.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("summary-download").click()]);
  const summary = readFileSync((await download.path())!, "utf8");
  expect(summary).toMatch(/### 🤖 Kainoa's Grok, answering Zach · \d\d:\d\d\n\n> Four\./);
  expect(summary).not.toContain("Guest");
});
