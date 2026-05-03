import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.js$/,
  workers: 1, // extension-loaded contexts can't be parallelized cleanly
  fullyParallel: false,
  reporter: "list",
  timeout: 30_000,
  use: {
    headless: !!process.env.CI,
    actionTimeout: 5_000,
  },
});
