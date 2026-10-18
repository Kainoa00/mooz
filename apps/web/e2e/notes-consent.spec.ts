import { expect, test } from "@playwright/test";
import { guestPage, joinAs, startMeeting } from "./fixtures";

test("only the host can allow agent notes, and the choice outlives a reload", async ({ page, browser }) => {
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");

  const toggle = page.getByTestId("notes-policy");
  await expect(toggle).not.toBeChecked();
  await expect(zach.getByTestId("notes-policy")).toHaveCount(0);

  await toggle.click();
  // Checked only once LiveKit has the new room metadata, which is what agents read.
  await expect(toggle).toBeChecked({ timeout: 10_000 });

  await page.reload();
  await joinAs(page, "Kainoa");
  await expect(page.getByTestId("notes-policy")).toBeChecked({ timeout: 10_000 });

  await page.getByTestId("notes-policy").click();
  await expect(page.getByTestId("notes-policy")).not.toBeChecked({ timeout: 10_000 });
});
