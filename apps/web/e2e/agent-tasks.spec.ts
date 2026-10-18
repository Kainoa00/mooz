import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { bridgeCommand, bringAgent, guestPage, joinAs, sendChat, startMeeting, tempHome, test } from "./fixtures";

const lastAgentReply = (p: Page) =>
  p.locator('[data-testid="chat-message"][data-kind="agent"] [data-testid="chat-text"]').last();
const agentSaid = (p: Page, text: string) =>
  p.locator('[data-testid="chat-message"][data-kind="agent"]').filter({ hasText: text });
const row = (p: Page, title: string) => p.getByTestId("task-row").filter({ hasText: title });
const report = (p: Page, title: string) =>
  p.locator('[data-testid="chat-message"][data-kind="agent"]').filter({ hasText: `📋 ${title}` });

test("the owner runs background research; everyone sees it, a private result stays with them", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const home = tempHome();
  const plans = path.join(home, "work", "plans");
  mkdirSync(plans, { recursive: true });
  writeFileSync(path.join(plans, "launch.md"), "The launch is on March 30th.\n");
  bridgeCommand(home, ["init", "Atlas", "--source", plans]);

  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");
  const bridge = await bringAgent(page, zach, baseURL!, ["--agent", "Atlas"], home);

  try {
    // Only the agent's owner can send it off to research.
    await sendChat(page, "@Atlas look into the launch");
    await expect(lastAgentReply(page)).toContainText("Only Zach can ask me to research", { timeout: 20_000 });
    await expect(page.getByTestId("task-panel")).toHaveCount(0);

    // The owner's task shows up for everyone, and the result lands in chat.
    await sendChat(zach, "@Atlas look into the launch");
    await expect(agentSaid(zach, "On it. I'll report back.")).toHaveCount(1, { timeout: 20_000 });
    for (const p of [page, zach]) {
      await expect(row(p, "Look into the launch")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
      await expect(report(p, "Look into the launch")).toContainText("March 30th", { timeout: 15_000 });
    }
    await expect(row(page, "Look into the launch").getByTestId("task-summary")).toContainText("launch");

    // A slow one only its owner can cancel, from the panel.
    await sendChat(zach, "@Atlas research the budget slowly");
    await expect(row(zach, "Research the budget slowly")).toHaveAttribute("data-state", "working", {
      timeout: 20_000,
    });
    await expect(row(page, "Research the budget slowly")).toHaveAttribute("data-state", "working");
    await expect(row(page, "Research the budget slowly").getByTestId("task-cancel")).toHaveCount(0);
    await row(zach, "Research the budget slowly").getByTestId("task-cancel").click();
    for (const p of [page, zach]) {
      await expect(row(p, "Research the budget slowly")).toHaveAttribute("data-state", "cancelled", {
        timeout: 15_000,
      });
    }

    // A private one: the owner gets the result; everyone else sees only that it exists.
    await sendChat(zach, "@Atlas find out the launch date privately");
    await expect(agentSaid(zach, "I'll tell you privately")).toHaveCount(1, { timeout: 20_000 });
    await expect(row(zach, "Find out the launch date")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
    await expect(row(zach, "Find out the launch date").getByTestId("task-details")).toContainText("March 30th");
    await expect(report(zach, "Find out the launch date")).toContainText("March 30th", { timeout: 15_000 });
    const theirs = row(page, "Private task for Zach");
    await expect(theirs).toHaveAttribute("data-state", "done", { timeout: 15_000 });
    await expect(theirs.getByTestId("task-details")).toHaveCount(0);
    await expect(theirs.getByTestId("task-summary")).toHaveCount(0);
    // (Zach's request itself is in the shared chat; only the result is private.)
    await expect(page.getByTestId("task-panel").getByText("Find out the launch date")).toHaveCount(0);
    await expect(report(page, "Find out the launch date")).toHaveCount(0);

    // Someone who joins later sees the same panel.
    const lee = await guestPage(browser, slug);
    await joinAs(lee, "Lee");
    await expect(lee.locator('[data-testid="participant-tile"][data-kind="agent"]')).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(row(lee, "Look into the launch")).toHaveAttribute("data-state", "done", { timeout: 15_000 });
    await expect(row(lee, "Private task for Zach")).toBeVisible();
    await expect(lee.getByTestId("task-panel").getByText("Find out the launch date")).toHaveCount(0);

    // Results are kept, privately, in the owner's local memory.
    const memory = path.join(bridge.home, "agents", "atlas", "memory.jsonl");
    await expect
      .poll(() => (existsSync(memory) ? readFileSync(memory, "utf8") : ""), { timeout: 15_000 })
      .toContain("Find out the launch date");
    const notes = readFileSync(memory, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(notes).toHaveLength(2);
    for (const note of notes) expect(note).toMatchObject({ public: false, tags: ["task-result"] });
  } catch (err) {
    console.log("bridge output:\n" + bridge.output());
    throw err;
  } finally {
    bridge.proc.kill();
  }
});
