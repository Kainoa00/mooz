import { expect } from "@playwright/test";
import { guestPage, joinAs, startMeeting, test } from "./fixtures";

test("a guest's agent waits for the host, who approves it", async ({ page, browser, request }) => {
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");

  await zach.getByRole("button", { name: "Bring my agent" }).click();
  await expect(zach.getByTestId("agent-command")).toContainText("mooz-agent connect");
  await expect(zach.getByTestId("agent-install")).toContainText("uv tool install mooz-agent");
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

test("the owner sees an agent waiting on their code, and can cancel it if it isn't theirs", async ({
  page,
  browser,
  request,
}) => {
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");

  await zach.getByRole("button", { name: "Bring my agent" }).click();
  const code = await zach.getByTestId("agent-code").textContent();
  await zach.getByRole("button", { name: "Done" }).click();

  // Someone else got hold of Zach's code and uses it.
  const claim = await request.post("/api/agent/claim", { data: { code, name: "Atlas" } });
  const { requestId, claimSecret } = await claim.json();
  await expect(page.getByTestId("agent-request")).toContainText("Zach's Atlas");

  // Zach sees it waiting, though he closed the dialog, and cancels it.
  const mine = zach.getByTestId("my-agent-request");
  await expect(mine).toContainText("Atlas is waiting for the host. Not yours?", { timeout: 10_000 });
  await mine.getByRole("button", { name: "Cancel it" }).click();
  await expect(mine).toHaveCount(0);

  await expect(page.getByTestId("agent-request")).toHaveCount(0, { timeout: 10_000 });
  const res = await request.get(`/api/agent/claim/${requestId}`, { headers: { authorization: `Bearer ${claimSecret}` } });
  expect(await res.json()).toEqual({ status: "denied" });
});
