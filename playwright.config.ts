import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Browser binaries live inside the codebase, never in the user profile.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(__dirname, ".data", "ms-playwright");

export default defineConfig({
  testDir: "./tests",
  timeout: 60000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      // Visible suite: the on-screen step banner must be watchable by a human.
      name: "chromium-visible",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { headless: false, slowMo: 350 },
      },
    },
  ],
});
