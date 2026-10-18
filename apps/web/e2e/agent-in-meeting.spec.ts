import { expect, test } from "@playwright/test";
import { connectAgent, guestPage, joinAs, sendChat, startMeeting } from "./fixtures";

test("a guest brings their agent; it answers when addressed and the host can remove it", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");

  await zach.getByRole("button", { name: "Bring my agent" }).click();
  const code = (await zach.getByTestId("agent-code").textContent())!;
  await zach.getByRole("button", { name: "Done" }).click();
  const bridge = connectAgent(code, baseURL!, ["--name", "Atlas"]);

  try {
    // The host approves; until then nothing joins.
    await expect(page.getByTestId("agent-request")).toContainText("Zach's Atlas", { timeout: 30_000 });
    await page.getByTestId("agent-request").getByRole("button", { name: "Approve" }).click();

    // The agent appears to everyone, unmistakably labelled.
    for (const p of [page, zach]) {
      const tile = p.locator('[data-testid="participant-tile"][data-kind="agent"]');
      await expect(tile).toHaveCount(1, { timeout: 30_000 });
      await expect(tile).toHaveAttribute("data-label", "🤖 Zach's Atlas");
      await expect(tile.getByTestId("agent-badge")).toBeVisible();
    }

    // Anyone can ask it; it answers in chat (and by voice, which the fake TTS makes silent).
    await sendChat(page, "@Atlas what is 2+2");
    const reply = zach.locator('[data-testid="chat-message"][data-kind="agent"]');
    await expect(reply.getByTestId("chat-text")).toHaveText("You asked: what is 2+2", { timeout: 15_000 });
    await expect(reply.getByTestId("chat-sender")).toHaveText("🤖 Zach's Atlas");

    // Merely mentioning it does not wake it.
    await sendChat(zach, "I asked Atlas yesterday");
    await page.waitForTimeout(1500);
    await expect(zach.locator('[data-testid="chat-message"][data-kind="agent"]')).toHaveCount(1);

    // Only the host sees Remove; removing disconnects the agent and the bridge exits.
    await expect(zach.getByRole("button", { name: "Remove agent" })).toHaveCount(0);
    await page.getByRole("button", { name: "Remove agent" }).click();
    await expect(page.locator('[data-testid="participant-tile"][data-kind="agent"]')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect.poll(() => bridge.proc.exitCode, { timeout: 15_000 }).not.toBeNull();
  } catch (err) {
    console.log("bridge output:\n" + bridge.output());
    throw err;
  } finally {
    bridge.proc.kill();
  }
});
