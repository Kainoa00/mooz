import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { bringAgent, guestPage, joinAs, sendChat, startMeeting } from "./fixtures";

const BANNER = "📝 Zach's Atlas is keeping notes";

const lastAgentReply = (p: Page) =>
  p.locator('[data-testid="chat-message"][data-kind="agent"] [data-testid="chat-text"]').last();

test("an agent keeps notes only with consent, and people who opt out stay out of them", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");
  const bridge = await bringAgent(page, zach, baseURL!, ["--name", "Atlas"]);

  try {
    // Off until the host allows it.
    await sendChat(zach, "@Atlas keep notes");
    await expect(lastAgentReply(zach)).toContainText("host hasn't allowed", { timeout: 15_000 });
    await expect(page.getByTestId("notes-banner")).toHaveCount(0);

    // Allowed, but only the agent's owner can start it.
    await page.getByTestId("notes-policy").click();
    await expect(page.getByTestId("notes-policy")).toBeChecked({ timeout: 10_000 });
    await sendChat(page, "@Atlas keep notes");
    await expect(lastAgentReply(page)).toContainText("Only Zach", { timeout: 15_000 });
    await sendChat(zach, "@Atlas keep notes");
    for (const p of [page, zach]) {
      await expect(p.getByTestId("notes-banner-text")).toHaveText(BANNER, { timeout: 15_000 });
    }

    // Someone who joins later is told too.
    const lee = await guestPage(browser, slug);
    await joinAs(lee, "Lee");
    await expect(lee.getByTestId("notes-banner-text")).toHaveText(BANNER, { timeout: 15_000 });

    // Kainoa opts out: what they say is never kept.
    await page.getByRole("button", { name: "Leave me out" }).click();
    await expect(page.getByTestId("notes-opted-out")).toBeVisible({ timeout: 10_000 });
    await sendChat(page, "my pineapple plan is secret");
    await sendChat(lee, "the launch is on Friday");
    await expect(lee.getByText("my pineapple plan is secret")).toBeVisible();

    await sendChat(zach, "@Atlas stop keeping notes");
    for (const p of [page, zach, lee]) {
      await expect(p.getByTestId("notes-banner")).toHaveCount(0, { timeout: 15_000 });
    }

    // Only a summary is saved, privately, in the owner's local memory.
    const memory = path.join(bridge.home, "agents", "atlas", "memory.jsonl");
    await expect
      .poll(() => (existsSync(memory) ? readFileSync(memory, "utf8") : ""), { timeout: 15_000 })
      .toContain("the launch is on Friday");
    const [note] = readFileSync(memory, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(note).toMatchObject({ public: false, tags: ["meeting-notes"] });
    expect(note.text).not.toContain("pineapple");
  } catch (err) {
    console.log("bridge output:\n" + bridge.output());
    throw err;
  } finally {
    bridge.proc.kill();
  }
});
