import { expect, type Page } from "@playwright/test";
import { bringAgent, guestPage, joinAs, sendChat, startMeeting, test, type Bridge } from "./fixtures";

const agentMessages = (page: Page) => page.locator('[data-testid="chat-message"][data-kind="agent"]');

test("agents answer one at a time, pause after going back and forth, and carry on when a person says so", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");
  const bridges: Bridge[] = [];
  try {
    bridges.push(await bringAgent(page, page, baseURL!, ["--name", "Atlas"]));
    bridges.push(await bringAgent(page, zach, baseURL!, ["--name", "Nova"], undefined, 2));
    const said = agentMessages(zach);

    // @everyone: both answer, one after the other.
    await sendChat(page, "@everyone what is 2+2");
    await expect(said).toHaveCount(2, { timeout: 30_000 });
    await expect(said.getByTestId("chat-text")).toHaveText(["You asked: what is 2+2", "You asked: what is 2+2"]);
    await expect(said.getByTestId("chat-sender")).toContainText(["🤖", "🤖"]);
    expect(new Set(await said.getByTestId("chat-sender").allTextContents())).toEqual(
      new Set(["🤖 Kainoa's Atlas", "🤖 Zach's Nova"]),
    );

    // Kainoa asks Atlas to ping Nova. They go back and forth: Atlas answers Kainoa, then three
    // agent-to-agent turns, and the next reply is held for a person.
    await sendChat(page, "@Atlas ping Nova");
    const paused = zach.getByTestId("agents-paused");
    await expect(paused).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("agents-paused")).toBeVisible();
    await expect(said).toHaveCount(6);
    await expect(said.getByTestId("chat-text")).toHaveText([
      /2\+2/,
      /2\+2/,
      "@Nova ping",
      "@Atlas ping",
      "@Nova ping",
      "@Atlas ping",
    ]);
    await page.waitForTimeout(3000);
    await expect(said).toHaveCount(6); // held, not sent
    await expect(zach.getByTestId("floor-strip")).toHaveCount(0); // nobody has the floor

    // Zach (not the host) lets them continue: the held reply goes out, and three turns later
    // they pause again.
    await paused.getByRole("button", { name: "Continue" }).click();
    await expect(said).toHaveCount(9, { timeout: 45_000 });
    await expect(said.nth(6).getByTestId("chat-text")).toHaveText("@Nova ping");
    await expect(paused).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3000);
    await expect(said).toHaveCount(9);
  } catch (err) {
    for (const b of bridges) console.log("bridge output:\n" + b.output());
    throw err;
  } finally {
    for (const b of bridges) b.proc.kill();
  }
});
