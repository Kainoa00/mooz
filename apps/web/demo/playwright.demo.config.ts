import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

/**
 * Records the README demo (`pnpm demo:record`, then `scripts/demo-gif.sh`): the offline agent
 * (no keys, no voice), with the host and a guest side by side. Not part of CI.
 */
export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "demo.spec.ts",
  outputDir: "../test-results/demo",
  timeout: 300_000,
  reporter: "list",
  use: {
    ...base.use,
    viewport: { width: 1280, height: 720 },
    video: { mode: "on", size: { width: 1280, height: 720 } },
    trace: "off",
  },
});
