import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { bridgeCommand, bringAgent, guestPage, joinAs, sendChat, startMeeting, tempHome } from "./fixtures";

const lastAgentReply = (p: Page) =>
  p.locator('[data-testid="chat-message"][data-kind="agent"] [data-testid="chat-text"]').last();

/** Ask in chat and wait for the agent's next reply (each question gets exactly one). */
async function ask(p: Page, question: string): Promise<string> {
  const replies = p.locator('[data-testid="chat-message"][data-kind="agent"]');
  const before = await replies.count();
  await sendChat(p, `@Atlas ${question}`);
  await expect(replies).toHaveCount(before + 1, { timeout: 20_000 });
  return (await lastAgentReply(p).textContent()) ?? "";
}

test("the owner reaches private sources and memory; everyone else only public ones", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const home = tempHome();
  const privateDir = path.join(home, "work", "private-plans");
  const publicDir = path.join(home, "work", "team-notes");
  mkdirSync(privateDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(path.join(privateDir, "secret.txt"), "The vault code is 7741.\n");
  writeFileSync(path.join(publicDir, "notes.txt"), "Standup moves to 10am.\n");
  bridgeCommand(home, ["init", "Atlas", "--source", privateDir, "--public-source", publicDir]);

  const slug = await startMeeting(page);
  await joinAs(page, "Kainoa");
  const zach = await guestPage(browser, slug);
  await joinAs(zach, "Zach");
  const bridge = await bringAgent(page, zach, baseURL!, ["--agent", "Atlas"], home);

  try {
    // A guest can't read the owner's private folder, and isn't told what's in it.
    const denied = await ask(page, "read secret.txt from private-plans");
    expect(denied).toContain("No source called 'private-plans'");
    expect(denied).not.toContain("7741");
    // A public folder is fine for anyone.
    expect(await ask(page, "read notes.txt from team-notes")).toContain("Standup moves to 10am.");
    // The owner reads the private file.
    expect(await ask(zach, "read secret.txt from private-plans")).toContain("The vault code is 7741.");

    // Only the owner can write memory, and private memories stay with them.
    expect(await ask(page, "remember that Kainoa runs the budget")).toContain("Only Zach can change my memory");
    expect(await ask(zach, "remember that the offsite is in Kona")).toContain("I'll remember");
    expect(await ask(page, "what do you remember?")).toContain("don't remember anything");
    expect(await ask(zach, "what do you remember?")).toContain("the offsite is in Kona");

    // After a reload the owner is still the owner.
    await zach.reload();
    await joinAs(zach, "Zach");
    await expect(zach.locator('[data-testid="participant-tile"][data-kind="agent"]')).toHaveCount(1, {
      timeout: 30_000,
    });
    expect(await ask(zach, "read secret.txt from private-plans")).toContain("The vault code is 7741.");

    // The memory lives on the owner's machine.
    expect(bridgeCommand(home, ["memory", "list", "--agent", "Atlas"])).toContain("the offsite is in Kona");
  } catch (err) {
    console.log("bridge output:\n" + bridge.output());
    throw err;
  } finally {
    bridge.proc.kill();
  }
});
