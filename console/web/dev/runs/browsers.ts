import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Playwright needs the browser builds it pins (`playwright install chromium ffmpeg`). When
 * only other builds are in the browser cache, this points `PLAYWRIGHT_BROWSERS_PATH` at a
 * directory of symlinks that names the newest cached builds with the pinned revisions, so
 * the seed still runs without downloading anything. The cache itself is never modified.
 */
export const browsers = async (seedRoot: string): Promise<Record<string, string>> => {
  const require = createRequire(import.meta.url);
  const pinned = JSON.parse(
    await readFile(
      join(
        dirname(
          require.resolve("playwright-core/package.json", {
            paths: [dirname(require.resolve("@playwright/test/package.json"))],
          }),
        ),
        "browsers.json",
      ),
      "utf8",
    ),
  ) as { browsers: ReadonlyArray<{ name: string; revision: string }> };
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : join(homedir(), ".cache", "ms-playwright"));
  if (!existsSync(cache)) return {};
  const cached = await readdir(cache);
  const wanted = ["chromium-headless-shell", "ffmpeg"].map((name) => {
    const revision = pinned.browsers.find((browser) => browser.name === name)?.revision ?? "";
    return { dir: `${name.replace(/-/g, "_")}-${revision}`, prefix: `${name.replace(/-/g, "_")}-` };
  });
  if (wanted.every(({ dir }) => cached.includes(dir))) return {};
  const shim = join(seedRoot, "browsers");
  await mkdir(shim, { recursive: true });
  for (const { dir, prefix } of wanted) {
    const source = cached.includes(dir)
      ? dir
      : cached
          .filter((name) => name.startsWith(prefix))
          .sort()
          .at(-1);
    if (source) await symlink(join(cache, source), join(shim, dir)).catch(() => undefined);
  }
  console.log(`[seed] using cached browser builds through ${shim}`);
  return { PLAYWRIGHT_BROWSERS_PATH: shim };
};
