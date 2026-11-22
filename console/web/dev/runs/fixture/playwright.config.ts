import { createRequire } from "node:module";
import { defineConfig } from "@playwright/test";

const require = createRequire(import.meta.url);

/** Run by `../generate.ts` once per seeded commit; see `app.ts` for `SEED_STEP`. */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: process.env.SEED_OUTPUT ?? "test-results",
  snapshotPathTemplate: `${process.env.SEED_SNAPSHOTS ?? "__snapshots__"}/{arg}{ext}`,
  retries: 1,
  workers: 2,
  timeout: 15_000,
  use: {
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  reporter: process.env.SEED_DIR
    ? [
        ["line"],
        [
          require.resolve("@highalch/console-playwright"),
          {
            project: "crm",
            dir: process.env.SEED_DIR,
            commit: "0000000000000000000000000000000000000000",
            branch: "seed",
            source: "github-actions",
            strict: true,
          },
        ],
      ]
    : [["line"]],
});
