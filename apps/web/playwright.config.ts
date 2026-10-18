import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  // Every test runs real video calls (and some a real bridge); in parallel they starve the CPU.
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    permissions: ["camera", "microphone"],
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm build && pnpm start -p ${port}`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      MOOZ_DB_PATH: ":memory:",
      LIVEKIT_URL: process.env.LIVEKIT_URL ?? "ws://localhost:7880",
      LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY ?? "devkey",
      LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET ?? "secret",
    },
  },
});
