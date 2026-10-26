import { expect, type Page } from "@playwright/test";
import { DataPacket_Kind, RoomServiceClient } from "livekit-server-sdk";
import { guestPage, joinAs, sendChat, startMeeting, test } from "./fixtures";

const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "ws://localhost:7880";
const livekit = new RoomServiceClient(
  LIVEKIT_URL.replace(/^ws/, "http"),
  process.env.LIVEKIT_API_KEY ?? "devkey",
  process.env.LIVEKIT_API_SECRET ?? "secret",
);

/** The newest LiveKit room these people are in (its name is the server's, not the link's). */
async function roomOf(...names: string[]): Promise<string> {
  const rooms = (await livekit.listRooms()).sort((a, b) => Number(b.creationTime - a.creationTime));
  for (const room of rooms) {
    const here = (await livekit.listParticipants(room.name)).map((p) => p.name);
    if (names.every((n) => here.includes(n))) return room.name;
  }
  throw new Error(`no room with ${names.join(", ")}`);
}

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

  // Anyone can publish on LiveKit's old chat topic. Packets that aren't a message (not JSON, null,
  // an object for an id) are ignored, and chat carries on in every tab.
  const room = await roomOf("Kainoa", "Zach");
  const good = JSON.stringify({ id: "legacy-ok", message: "legacy ok", timestamp: Date.now() });
  for (const packet of ["{oops", "null", JSON.stringify({ id: { toString: 1 }, message: "boom", timestamp: 1 }), good]) {
    await livekit.sendData(room, new TextEncoder().encode(packet), DataPacket_Kind.RELIABLE, { topic: "lk-chat-topic" });
  }
  // A well-formed one, sent last on the same reliable channel, shows the others arrived first.
  for (const p of [page, zach]) await expect(p.getByTestId("chat-message").filter({ hasText: "legacy ok" })).toBeVisible();
  await sendChat(zach, "still here");
  for (const p of [page, zach]) {
    await expect(p.getByTestId("chat-message").filter({ hasText: "still here" })).toBeVisible();
    await expect(p.getByTestId("participant-tile")).toHaveCount(2);
  }
});

test("an unknown meeting link shows an error on join", async ({ page }) => {
  await page.goto("/r/zzz-zzzz-zzz");
  await page.getByLabel("Your name").fill("Zach");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "No such meeting" })).toBeVisible();
});

const callFailed = (p: Page) => p.getByRole("alert").filter({ hasText: "The call couldn't connect" });

/**
 * The LiveKit room this tab is in, and its identity there. Found by identity (each join's is
 * unique), not by name: other test runs may share this LiveKit, with the same names.
 */
async function whereIs(p: Page, slug: string): Promise<{ room: string; identity: string }> {
  const identity = await p.evaluate((s) => sessionStorage.getItem(`mooz_joined_${s}`), slug);
  for (const room of await livekit.listRooms()) {
    const here = await livekit.listParticipants(room.name).catch(() => []); // it may have just ended
    if (here.some((x) => x.identity === identity)) {
      return { room: room.name, identity: identity! };
    }
  }
  throw new Error(`no room with ${identity}`);
}

test("a call that can't reach LiveKit says why, on the join form or with the host's summary", async ({ page }) => {
  await startMeeting(page);
  // As when Chrome won't let a page from a public address (a tunnel) reach LiveKit on localhost.
  const callServer = new URL(LIVEKIT_URL).host;
  let blocked = true;
  await page.routeWebSocket(
    (url) => url.host === callServer,
    (ws) => (blocked ? ws.close() : ws.connectToServer()),
  );
  await page.route(
    (url) => url.host === callServer,
    (route) => (blocked ? route.abort() : route.continue()),
  );

  await page.getByLabel("Your name").fill("Kainoa");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(callFailed(page)).toBeVisible({ timeout: 20_000 });
  await expect(callFailed(page)).toContainText("http://localhost:3000");
  await expect(page.getByRole("heading", { name: "Join meeting" })).toBeVisible();

  // Once it can reach it, joining again works.
  blocked = false;
  await joinAs(page, "Kainoa");
  await expect(callFailed(page)).toHaveCount(0);

  // The host leaves, and can't get back in: the summary stays, with the reason.
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(page.getByTestId("left-meeting")).toBeVisible({ timeout: 15_000 });
  blocked = true;
  await page.getByRole("button", { name: "Join again" }).click();
  await page.getByLabel("Your name").fill("Kainoa");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(callFailed(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("left-meeting")).toBeVisible();
  await expect(page.getByRole("heading", { name: "You're out of the meeting" })).toBeVisible();
  await expect(page.getByTestId("summary-download")).toBeVisible();
});

test("leaving, being removed, or the meeting ending isn't shown as a failed call", async ({ page, browser }) => {
  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");
  const joinForm = (p: Page) => p.getByRole("heading", { name: "Join meeting" });

  // Zach leaves: back to the name form, no error.
  await zach.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(joinForm(zach)).toBeVisible();
  await expect(callFailed(zach)).toHaveCount(0);

  // Zach is removed.
  await joinAs(zach, "Zach");
  const { room, identity } = await whereIs(zach, slug);
  await livekit.removeParticipant(room, identity);
  await expect(joinForm(zach)).toBeVisible({ timeout: 15_000 });
  await expect(callFailed(zach)).toHaveCount(0);

  // The host leaves: the summary view, as before.
  await joinAs(zach, "Zach");
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(page.getByTestId("left-meeting")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "You left the meeting" })).toBeVisible();
  await expect(callFailed(page)).toHaveCount(0);

  // The meeting ends while everyone's in it.
  await page.getByRole("button", { name: "Join again" }).click();
  await joinAs(page, "Kainoa");
  await livekit.deleteRoom((await whereIs(page, slug)).room);
  await expect(page.getByTestId("left-meeting")).toBeVisible({ timeout: 15_000 });
  await expect(joinForm(zach)).toBeVisible({ timeout: 15_000 });
  for (const p of [page, zach]) await expect(callFailed(p)).toHaveCount(0);
});
