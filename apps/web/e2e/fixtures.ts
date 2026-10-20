import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as base, expect, type Browser, type Page } from "@playwright/test";

const BRIDGE_DIR = process.env.MOOZ_BRIDGE_DIR ?? path.resolve(__dirname, "../../../bridge");

/**
 * Playwright's `test`, plus: guests' browser contexts close when the test ends. Left open, their
 * video calls carry on through every later test and starve the machine.
 */
export const test = base.extend<{ closeGuests: void }>({
  closeGuests: [
    async ({ browser, context }, use) => {
      await use();
      await Promise.all(browser.contexts().filter((c) => c !== context).map((c) => c.close()));
    },
    { auto: true },
  ],
});

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

/** A throwaway MOOZ_HOME, so agents' settings and memory never touch a real ~/.mooz. */
export function tempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "mooz-e2e-"));
}

function bridgeEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, MOOZ_PROVIDERS: "fake", MOOZ_HOME: home, UV_NATIVE_TLS: undefined };
}

/** Run a quick bridge command (like `init` or `memory list`) and return its output. */
export function bridgeCommand(home: string, args: string[]): string {
  const result = spawnSync("uv", ["run", "mooz-agent", ...args], { cwd: BRIDGE_DIR, env: bridgeEnv(home), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`mooz-agent ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

export interface Bridge {
  proc: ChildProcess;
  output: () => string;
  home: string;
}

/** Run the real bridge CLI with offline providers (no API keys, no audio models). */
export function connectAgent(code: string, server: string, who: string[], home = tempHome()): Bridge {
  let output = "";
  const proc = spawn("uv", ["run", "mooz-agent", "connect", code, "--server", server, ...who], {
    cwd: BRIDGE_DIR,
    env: bridgeEnv(home),
  });
  proc.stdout?.on("data", (d) => (output += d));
  proc.stderr?.on("data", (d) => (output += d));
  return { proc, output: () => output, home };
}

/**
 * The owner brings an agent and the host approves it. Returns once everyone sees it (and the
 * meeting has `agents` agents). `who` is `["--name", "Atlas"]` or `["--agent", "Atlas"]`.
 */
export async function bringAgent(
  host: Page,
  owner: Page,
  server: string,
  who: string[],
  home?: string,
  agents = 1,
): Promise<Bridge> {
  await owner.getByRole("button", { name: "Bring my agent" }).click();
  const code = (await owner.getByTestId("agent-code").textContent())!;
  await owner.getByRole("button", { name: "Done" }).click();
  const bridge = connectAgent(code, server, who, home);
  try {
    // Generous: a busy machine running several video calls can be slow to start the bridge.
    await expect(host.getByTestId("agent-request")).toBeVisible({ timeout: 60_000 });
    await host.getByTestId("agent-request").getByRole("button", { name: "Approve" }).click();
    for (const p of [host, owner]) {
      await expect(p.locator('[data-testid="participant-tile"][data-kind="agent"]')).toHaveCount(agents, {
        timeout: 30_000,
      });
    }
  } catch (err) {
    console.log("bridge output:\n" + bridge.output());
    bridge.proc.kill();
    throw err;
  }
  return bridge;
}
