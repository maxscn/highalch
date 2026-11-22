/**
 * Generates the dashboard's development seed with the real tools: six Playwright runs of
 * `fixture/` (the base commit and the five commits of the seeded pull request) through
 * `@highalch/console-playwright`, and two fuzz runs through `@highalch/console-fuzz`. Both reporters write their
 * offline payloads (`<dir>/runs/<id>/`), which `../seed.ts` uploads into the in-memory
 * Console. Output: `apps/console-web/.seed/`. Pass `--if-missing` to skip when present.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browsers } from "./browsers.ts";
import { generate as generateFuzz } from "./fuzz.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const seedRoot = join(here, "..", "..", ".seed");
const done = join(seedRoot, "done.json");

const playwright = (env: Record<string, string>, args: ReadonlyArray<string> = []) =>
  new Promise<string>((resolve) => {
    const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
    execFile(
      process.execPath,
      [cli, "test", "-c", join(here, "fixture", "playwright.config.ts"), ...args],
      { cwd: join(here, "fixture"), env: { ...process.env, CI: "", ...env }, timeout: 300_000 },
      (_error, stdout, stderr) => resolve(stdout + stderr),
    );
  });

export const steps = [0, 1, 2, 3, 4, 5] as const;

const main = async () => {
  if (process.argv.includes("--if-missing") && existsSync(done)) return;
  await rm(seedRoot, { recursive: true, force: true });
  const snapshots = join(seedRoot, "snapshots");
  await mkdir(snapshots, { recursive: true });
  const browser = await browsers(seedRoot);
  console.log("[seed] recording snapshot baselines");
  await playwright(
    {
      ...browser,
      SEED_STEP: "0",
      SEED_SNAPSHOTS: snapshots,
      SEED_OUTPUT: join(seedRoot, "out", "baseline"),
    },
    ["--update-snapshots", "--grep", "matches the design"],
  );
  for (const step of steps) {
    console.log(`[seed] Playwright run for step ${step}`);
    const output = await playwright({
      ...browser,
      SEED_STEP: String(step),
      SEED_SNAPSHOTS: snapshots,
      SEED_OUTPUT: join(seedRoot, "out", `step-${step}`),
      SEED_DIR: join(seedRoot, "playwright", `step-${step}`),
    });
    const summary = output.split("\n").filter((line) => /passed|failed|flaky|skipped/.test(line));
    console.log(summary.slice(-4).join("\n"));
  }
  for (const variant of ["base", "pr3", "head"] as const) {
    console.log(`[seed] fuzz run (${variant})`);
    await generateFuzz(join(seedRoot, "fuzz", variant), variant);
  }
  await writeFile(done, `${JSON.stringify({ generatedAt: new Date().toISOString() })}\n`);
  console.log(`[seed] wrote ${seedRoot}`);
};

await main();
