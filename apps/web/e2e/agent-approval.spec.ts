import { expect, test } from "@playwright/test";
import { guestPage, joinAs, startMeeting } from "./fixtures";

test("a guest's agent waits for the host, who approves it", async ({ page, browser, request }) => {
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");

  await zach.getByRole("button", { name: "Bring my agent" }).click();
  await expect(zach.getByTestId("agent-command")).toContainText("mooz-agent connect");
  const code = await zach.getByTestId("agent-code").textContent();

  // What `mooz-agent connect` does: redeem the code, then poll.
  const claim = await request.post("/api/agent/claim", { data: { code, name: "Grok" } });
  expect(claim.status()).toBe(201);
  const { requestId, claimSecret } = await claim.json();
  const poll = () =>
    request.get(`/api/agent/claim/${requestId}`, { headers: { authorization: `Bearer ${claimSecret}` } });
  expect(await (await poll()).json()).toEqual({ status: "pending" });

  // Only the host sees the request.
  const pending = page.getByTestId("agent-request");
  await expect(pending).toContainText("Zach's Grok");
  await expect(zach.getByTestId("agent-request")).toHaveCount(0);

  await pending.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("agent-request")).toHaveCount(0);

  const approved = await (await poll()).json();
  expect(approved).toMatchObject({ status: "approved", name: "Grok" });
  // The agent learns only LiveKit's internal room name, never the meeting link.
  expect(approved.room).not.toBe(slug);
  expect(approved.token).toBeTruthy();
});

test("a used code cannot bring a second agent", async ({ page, request }) => {
  await startMeeting(page);
  await joinAs(page, "Kainoa");
  await page.getByRole("button", { name: "Bring my agent" }).click();
  const code = await page.getByTestId("agent-code").textContent();

  expect((await request.post("/api/agent/claim", { data: { code, name: "Atlas" } })).status()).toBe(201);
  expect((await request.post("/api/agent/claim", { data: { code, name: "Other" } })).status()).toBe(400);
});
