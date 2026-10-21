import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { bridgeCommand, connectAgent, joinAs, sendChat, tempHome, type Bridge } from "../e2e/fixtures";

// Raw recordings and screenshots, for scripts/demo-gif.sh (which writes docs/media).
const OUT = path.resolve(__dirname, "../test-results/demo");
const SIZE = { width: 1280, height: 720 };

/** A browser window that records itself. */
async function windowFor(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: SIZE,
    permissions: ["camera", "microphone"],
    recordVideo: { dir: path.join(OUT, `${name}-video`), size: SIZE },
    acceptDownloads: true,
  });
  return context.newPage();
}

/** A caption along the bottom of the window, saying what's happening (and that it's offline). */
async function caption(page: Page, who: string, text: string): Promise<void> {
  await page.evaluate(
    ([who, text]) => {
      let box = document.getElementById("mooz-demo-caption");
      if (!box) {
        box = document.createElement("div");
        box.id = "mooz-demo-caption";
        Object.assign(box.style, {
          position: "fixed",
          left: "0",
          right: "0",
          bottom: "0",
          zIndex: "2147483647",
          padding: "10px 16px",
          font: "600 22px system-ui, sans-serif",
          color: "#fff",
          background: "rgba(17, 17, 27, 0.88)",
          pointerEvents: "none",
        });
        document.body.append(box);
      }
      box.textContent = `${who} · ${text}`;
      const note = document.createElement("span");
      note.textContent = "  (offline demo: scripted agent, no voice)";
      Object.assign(note.style, { fontWeight: "400", fontSize: "16px", opacity: "0.7" });
      box.append(note);
    },
    [who, text],
  );
}

async function both(host: Page, guest: Page, text: string, pause = 1200): Promise<void> {
  await Promise.all([caption(host, "Kainoa (host)", text), caption(guest, "Zach (guest)", text)]);
  await host.waitForTimeout(pause);
}

const agentMessages = (p: Page) => p.locator('[data-testid="chat-message"][data-kind="agent"]');
const agentTiles = (p: Page) => p.locator('[data-testid="participant-tile"][data-kind="agent"]');

/** The owner gets a code from the dialog and runs the bridge with it; the host sees the request. */
async function bring(host: Page, owner: Page, server: string, who: string[], home: string) {
  await owner.getByRole("button", { name: "Bring my agent" }).click();
  await owner.getByRole("tab", { name: "mooz-agent on my machine" }).click();
  const code = (await owner.getByTestId("agent-code").textContent())!;
  await owner.waitForTimeout(1500);
  await owner.getByRole("button", { name: "Done" }).click();
  const bridge = connectAgent(code, server, who, home);
  await expect(host.getByTestId("agent-request")).toBeVisible({ timeout: 60_000 });
  return bridge;
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(path.join(OUT, "shots"), { recursive: true });
  await page.evaluate(() => document.getElementById("mooz-demo-caption")?.remove());
  await page.screenshot({ path: path.join(OUT, "shots", `${name}.png`) });
}

test("the README demo", async ({ browser, baseURL }) => {
  const home = tempHome();
  const project = path.join(home, "work", "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "plan.md"), "Ship the beta on March 30th. Docs freeze a week before.\n");
  bridgeCommand(home, ["init", "Atlas", "--source", project]);

  const host = await windowFor(browser, "host");
  const guest = await windowFor(browser, "guest");
  const bridges: Bridge[] = [];
  try {
    // 1. A meeting by link.
    await host.goto("/");
    await guest.goto("/");
    await both(host, guest, "Start a meeting, share the link");
    await host.getByRole("button", { name: "Start a meeting" }).click();
    await host.waitForURL(/\/r\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    await caption(host, "Kainoa (host)", "Start a meeting, share the link");
    await joinAs(host, "Kainoa");
    await guest.goto(host.url());
    await caption(guest, "Zach (guest)", "Joins by the link");
    await joinAs(guest, "Zach");
    await both(host, guest, "Two people in a meeting");

    // 2. Zach brings his agent; the host approves it.
    await both(host, guest, "Zach brings his own agent: it runs on his machine, with his keys", 600);
    bridges.push(await bring(host, guest, baseURL!, ["--agent", "Atlas"], home));
    await both(host, guest, "Every agent waits for the host's approval", 1500);
    await shot(host, "approve");
    await caption(host, "Kainoa (host)", "Every agent waits for the host's approval");
    await host.getByTestId("agent-request").getByRole("button", { name: "Approve" }).click();
    for (const p of [host, guest]) await expect(agentTiles(p)).toHaveCount(1, { timeout: 30_000 });
    await both(host, guest, "Always shown as an agent: 🤖 Zach's Atlas", 2000);

    // 3. Asked by name, it answers from Zach's files.
    await both(host, guest, "Ask it by name", 600);
    await sendChat(guest, "@Atlas read plan.md from project");
    await expect(agentMessages(host)).toHaveCount(1, { timeout: 20_000 });
    await both(host, guest, "It answers from the folders Zach gave it", 2500);
    await shot(guest, "answer");

    // 4. Just mentioning it doesn't wake it.
    await sendChat(host, "I asked Atlas about the beta yesterday");
    await both(host, guest, "Just mentioning it doesn't wake it", 3500);
    await expect(agentMessages(host)).toHaveCount(1);

    // 5. Background research.
    await sendChat(guest, "@Atlas look into the beta plan");
    await both(host, guest, "“Look into…” starts background research; everyone sees the task", 600);
    for (const p of [host, guest]) {
      await expect(p.getByTestId("task-row").first()).toHaveAttribute("data-state", "done", { timeout: 30_000 });
    }
    await expect(agentMessages(host).filter({ hasText: "📋" })).toHaveCount(1, { timeout: 15_000 });
    await both(host, guest, "It reports back when it's done", 2500);
    await shot(host, "task");

    // 6. A second agent: they take turns, and pause after going back and forth.
    await both(host, guest, "Kainoa brings an agent too", 600);
    bridges.push(await bring(host, host, baseURL!, ["--name", "Nova"], tempHome()));
    await host.getByTestId("agent-request").getByRole("button", { name: "Approve" }).click();
    for (const p of [host, guest]) await expect(agentTiles(p)).toHaveCount(2, { timeout: 30_000 });
    await sendChat(guest, "@Atlas ping Nova");
    await both(host, guest, "Agents can ask each other, one speaker at a time", 600);
    await expect(guest.getByTestId("agents-paused")).toBeVisible({ timeout: 45_000 });
    await both(host, guest, "After 3 replies back and forth they pause, until someone says Continue", 2500);
    await shot(guest, "floor");
    await guest.getByTestId("agents-paused").getByRole("button", { name: "Continue" }).click();
    await both(host, guest, "Anyone can let them continue", 2500);

    // 7. The host's summary.
    await caption(host, "Kainoa (host)", "The host downloads a summary: agents' public words only");
    const [download] = await Promise.all([host.waitForEvent("download"), host.getByTestId("summary-download").click()]);
    const summary = readFileSync((await download.path())!, "utf8");
    await host.waitForTimeout(800);
    await host.goto(`data:text/plain;charset=utf-8,${encodeURIComponent(summary)}`);
    await caption(host, "Kainoa (host)", "Built in the host's tab; never sent to the server");
    await caption(guest, "Zach (guest)", "Built in the host's tab; never sent to the server");
    await host.waitForTimeout(3000);
    await shot(host, "summary");
  } finally {
    for (const b of bridges) b.proc.kill();
    for (const [name, page] of [
      ["host", host],
      ["guest", guest],
    ] as const) {
      await page.context().close();
      await page.video()?.saveAs(path.join(OUT, `${name}.webm`));
    }
  }
});
