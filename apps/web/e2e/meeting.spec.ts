import { expect } from "@playwright/test";
import { DataPacket_Kind, RoomServiceClient } from "livekit-server-sdk";
import { guestPage, joinAs, sendChat, startMeeting, test } from "./fixtures";

const livekit = new RoomServiceClient(
  (process.env.LIVEKIT_URL ?? "ws://localhost:7880").replace(/^ws/, "http"),
  process.env.LIVEKIT_API_KEY ?? "devkey",
  process.env.LIVEKIT_API_SECRET ?? "secret",
);

/** The LiveKit room these people are in (its name is the server's, not the link's). */
async function roomOf(...names: string[]): Promise<string> {
  for (const room of await livekit.listRooms()) {
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
  for (const bad of ["{oops", "null", JSON.stringify({ id: { toString: 1 }, message: "boom", timestamp: 1 })]) {
    await livekit.sendData(room, new TextEncoder().encode(bad), DataPacket_Kind.RELIABLE, { topic: "lk-chat-topic" });
  }
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
