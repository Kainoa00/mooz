import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { bridgeCommand, bringAgent, guestPage, joinAs, sendChat, startMeeting, tempHome, test } from "./fixtures";

const agentSaid = (p: Page, text: string) =>
  p.locator('[data-testid="chat-message"][data-kind="agent"]').filter({ hasText: text });

async function downloadSummary(page: Page): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("summary-download").click()]);
  return { name: download.suggestedFilename(), text: readFileSync((await download.path())!, "utf8") };
}

test("the host downloads a summary of the agents' public words, and nothing of anyone who opted out", async ({
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
  const lee = await guestPage(browser, slug);
  await joinAs(lee, "Lee");
  const bridge = await bringAgent(page, page, baseURL!, ["--agent", "Atlas"], home);

  try {
    // Only the host gets the button.
    await expect(page.getByTestId("summary-download")).toBeVisible();
    await expect(lee.getByTestId("summary-download")).toHaveCount(0);

    // A public answer, public research, and research the host asked for privately.
    await sendChat(page, "@Atlas good morning everyone");
    await expect(agentSaid(page, "good morning everyone")).toHaveCount(1, { timeout: 20_000 });
    await sendChat(page, "@Atlas look into the launch");
    await expect(agentSaid(page, "📋 Look into the launch")).toContainText("March 30th", { timeout: 30_000 });
    await sendChat(page, "@Atlas find out the launch date privately");
    await expect(agentSaid(page, "📋 Find out the launch date")).toContainText("March 30th", { timeout: 30_000 });

    // Notes on; Lee asks to be left out, then asks Atlas something.
    await page.getByTestId("notes-policy").click();
    await expect(page.getByTestId("notes-policy")).toBeChecked({ timeout: 10_000 });
    await sendChat(page, "@Atlas keep notes");
    await expect(lee.getByTestId("notes-banner")).toBeVisible({ timeout: 15_000 });
    await lee.getByRole("button", { name: "Leave me out" }).click();
    await expect(lee.getByTestId("notes-opted-out")).toBeVisible({ timeout: 10_000 });
    await sendChat(lee, "@Atlas tell me about pineapples");
    await expect(agentSaid(page, "pineapples")).toHaveCount(1, { timeout: 20_000 });

    const { name, text } = await downloadSummary(page);
    expect(name).toMatch(/^mooz-meeting-\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
    expect(text).toContain("# Meeting summary");
    expect(text).toContain("- Kainoa\n");
    expect(text).toContain("🤖 Kainoa's Atlas (agent, through mooz-agent)");
    expect(text).toContain("good morning everyone");
    expect(text).toMatch(/### 🤖 Kainoa's Atlas · \d\d:\d\d: Look into the launch/);
    expect(text).toContain("March 30th");
    expect(text).toContain("- Kept notes: 🤖 Kainoa's Atlas");
    // Not here: anyone's own words, the private result, or anything of Lee's.
    // (The summary writes "@" as "＠" so it can't ping anyone, so look for either, and for the
    // host's own words without it.)
    expect(text).not.toMatch(/[@＠]Atlas/);
    for (const absent of ["find out the launch date privately", "keep notes", "Find out the launch date", "pineapple", "Lee", slug]) {
      expect(text).not.toContain(absent);
    }
    expect(text).toContain("- and 1 more left out");

    // After leaving, the summary is still there until the host discards it.
    await page.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page.getByTestId("left-meeting")).toBeVisible({ timeout: 15_000 });
    expect((await downloadSummary(page)).text).toBe(text);
    await page.getByTestId("summary-discard").click();
    await expect(page.getByRole("button", { name: "Join" })).toBeVisible();
  } catch (err) {
    console.log("bridge output:\n" + bridge.output());
    throw err;
  } finally {
    bridge.proc.kill();
  }
});
