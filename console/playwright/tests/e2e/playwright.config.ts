import { defineConfig } from "@playwright/test";

// Driven by tests/reporter.e2e.test.ts (`vp run test:console-e2e`); not a test file itself.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: process.env.E2E_OUTPUT ?? "test-results",
  snapshotPathTemplate: `${process.env.E2E_SNAPSHOTS ?? "__snapshots__"}/{arg}{ext}`,
  retries: 1,
  workers: 1,
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  reporter: [
    [
      "../../src/index.ts",
      {
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        branch: "main",
        pr: 7,
        strict: true,
      },
    ],
  ],
});
