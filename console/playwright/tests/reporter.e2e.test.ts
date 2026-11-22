import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import { describe, expect, it } from "vite-plus/test";
import type { Results } from "@highalch/console-client";
import { playwright, png, withConsole } from "./support.ts";

/** A real Playwright run (its CLI, `e2e/`) reporting to a local Console. */

const decoder = new TextDecoder();

describe("ConsoleReporter end to end", () => {
  it(
    "uploads a real Playwright run with retries, steps and every attachment kind",
    { timeout: 150_000 },
    () =>
      withConsole(async (local) => {
        const snapshots = await mkdtemp(join(tmpdir(), "highalch-pw-snap-"));
        await writeFile(join(snapshots, "swatch.png"), png([255, 0, 0]));
        await writeFile(join(snapshots, "blue.png"), png([0, 0, 255]));
        const { output } = await playwright({
          HIGHALCH_URL: local.url,
          HIGHALCH_API_KEY: local.apiKey,
          E2E_SNAPSHOTS: snapshots,
          E2E_OUTPUT: await mkdtemp(join(tmpdir(), "highalch-pw-out-")),
        });
        const runs = await Effect.runPromise(
          local.asOwner((api, options) => api.Runs({ org: local.org }, options)),
        );
        const id = runs.entries[0]?.id;
        expect(id, output).toBeDefined();
        const run = await Effect.runPromise(
          local.asOwner((api, options) => api.RunById({ run: RunId.make(id ?? "") }, options)),
        );
        expect(run).toMatchObject({
          project: "e2e",
          commit: "abcdef0123456789abcdef0123456789abcdef01",
          branch: "main",
          pr: 7,
          source: "local",
          kind: "playwright",
        });
        const tests = new Map(
          [...local.objects.entries()]
            .filter(
              ([key]) => key.startsWith(`r/${local.org}/${id}/`) && key.endsWith(".tests.json"),
            )
            .flatMap(([, { body }]) => JSON.parse(decoder.decode(body)) as Array<Results.TestItem>)
            .map((test) => [test.title, test]),
        );
        const passed = tests.get("passes with steps and attachments");
        expect(passed).toMatchObject({
          status: "passed",
          titlePath: ["checkout"],
          file: "sample.spec.ts",
          project: "chromium",
          browser: "chromium",
          retries: 0,
          tags: ["@smoke"],
          subject: { kind: "page", name: "checkout" },
        });
        const attempt = passed?.attempts[0];
        expect(attempt?.stdout).toContain("hello from stdout");
        const outer = attempt?.steps.find((step) => step.title === "outer");
        expect(outer?.category).toBe("test.step");
        expect(outer?.steps[0]?.title).toBe("inner");
        expect(attempt?.attachments.map((a) => a.kind).sort()).toEqual([
          "screenshot",
          "trace",
          "video",
        ]);
        expect(tests.get("is flaky")).toMatchObject({ status: "flaky", retries: 1 });
        expect(tests.get("is flaky")?.attempts.map((a) => a.status)).toEqual(["failed", "passed"]);
        const failed = tests.get("fails");
        expect(failed?.status).toBe("failed");
        const error = failed?.attempts[0]?.errors[0];
        expect(error?.message).toContain("a failing assertion");
        expect(error?.message).not.toContain("\u001b[");
        expect(error?.location).toMatchObject({ file: "sample.spec.ts" });
        expect(error?.snippet).toContain('expect("actual"');
        expect(tests.get("is skipped")).toMatchObject({
          status: "skipped",
          annotations: [{ type: "skip", description: "not today" }],
        });
        const kinds = tests
          .get("snapshot mismatch")
          ?.attempts[0]?.attachments.map((a) => a.kind)
          .sort();
        // Playwright also attaches an "error-context" markdown file to failures (kind "other").
        expect(kinds).toEqual(["other", "snapshot-actual", "snapshot-diff", "snapshot-expected"]);
        const artifacts = await Effect.runPromise(
          local.asOwner((api, options) => api.Artifacts({ run: RunId.make(id ?? "") }, options)),
        );
        const declared = JSON.stringify(artifacts);
        for (const test of tests.values())
          for (const a of test.attempts.flatMap((x) => x.attachments))
            expect(declared).toContain(a.artifactId);
      }),
  );
});
