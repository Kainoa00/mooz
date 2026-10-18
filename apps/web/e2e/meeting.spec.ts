import { expect, test } from "@playwright/test";
import { guestPage, joinAs, sendChat, startMeeting } from "./fixtures";

test("two people meet by link, see each other, and chat", async ({ page, browser }) => {
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  await expect(page.getByText("You are the host")).toBeVisible();

  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");

  for (const p of [page, zach]) {
    await expect(p.getByTestId("participant-tile")).toHaveCount(2);
    await expect(p.locator('[data-testid="participant-tile"][data-kind="agent"]')).toHaveCount(0);
  }

  await sendChat(page, "hello from Kainoa");
  const received = zach.getByTestId("chat-message").filter({ hasText: "hello from Kainoa" });
  await expect(received).toBeVisible();
  await expect(received.getByTestId("chat-sender")).toHaveText("Kainoa");
});

test("an unknown meeting link shows an error on join", async ({ page }) => {
  await page.goto("/r/zzz-zzzz-zzz");
  await page.getByLabel("Your name").fill("Zach");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "No such meeting" })).toBeVisible();
});
