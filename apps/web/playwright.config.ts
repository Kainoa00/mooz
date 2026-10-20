import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * What the fake microphones hear, on a loop: a short tone (someone says something), then
 * quiet. Chrome's default beeps on and on, and agents wait for people to stop talking.
 */
function fakeMicrophone(): string {
  const rate = 8000;
  const samples = new Int16Array(rate * 10);
  for (let i = 0; i < rate * 0.4; i++) samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  const file = path.join(tmpdir(), "mooz-e2e-microphone.wav");
  writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer)]));
  return file;
}

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
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${fakeMicrophone()}`,
      ],
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
