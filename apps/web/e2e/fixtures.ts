import { expect, type Browser, type Page } from "@playwright/test";

export async function startMeeting(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Start a meeting" }).click();
  await page.waitForURL(/\/r\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  return new URL(page.url()).pathname.split("/").pop()!;
}

export async function joinAs(page: Page, name: string): Promise<void> {
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByLabel("Message")).toBeVisible();
}

/** A second participant in their own browser context (separate cookies). */
export async function guestPage(browser: Browser, slug: string): Promise<Page> {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  await page.goto(`/r/${slug}`);
  return page;
}

export async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByLabel("Message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}
