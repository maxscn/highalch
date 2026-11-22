import { describe, it } from "vite-plus/test";
import { Db } from "@highalch/story/tanstack-db";
import { billing, runs } from "../src/Console.collections.ts";
import { KindMismatch } from "../src/Organization/RecordResults.command.ts";
import { RunId } from "../src/Run/Run.id.ts";
import type { StoryHeader, StorySummary } from "../src/Story/Story.values.ts";
import {
  acmeCrm,
  alice,
  apiKey,
  bearer,
  ci,
  console,
  crm,
  existingProject,
  noCounts,
  orgA,
  paidOrganization,
  run1,
  run2,
  runContext,
  session,
  Story,
} from "./support.ts";

const crmKey = apiKey(crm, "k1");

const people = [
  [orgA, session(alice)],
  ["ci", bearer(crmKey.token)],
] as const;

const history = [
  paidOrganization(orgA, alice),
  ...existingProject(crm, orgA, { repository: acmeCrm, keys: [crmKey] }),
];

type FrameStatus = keyof StorySummary["frames"];

const report = (slug: string, status: "passed" | "failed", run: RunId): StoryHeader => ({
  slug,
  name: slug,
  test: null,
  status,
  durationMs: 10,
  host: "memory",
  scope: "acc-1",
  clock: "manual",
  invariants: [],
  failure: status === "failed" ? { step: 2, reason: "does not show what was expected" } : null,
  explore: null,
  report: `${run}.1`,
});

/** What a story's steps add up to: one step per frame (`null`: no frame). */
const summarised = (
  status: "passed" | "failed",
  frames: ReadonlyArray<FrameStatus | null>,
): StorySummary => ({
  steps: {
    passed: frames.length - (status === "failed" ? 1 : 0),
    failed: status === "failed" ? 1 : 0,
    notRun: 0,
  },
  kinds: frames.some((frame) => frame !== null) ? ["given", "render"] : ["given"],
  frames: {
    matched: frames.filter((f) => f === "matched").length,
    created: frames.filter((f) => f === "created").length,
    updated: frames.filter((f) => f === "updated").length,
    missing: frames.filter((f) => f === "missing").length,
    mismatch: frames.filter((f) => f === "mismatch").length,
  },
});

/** CI opens `run` of `kind` and declares a story report and a frame (`<run>.1`, `<run>.2`). */
const opened = (run: RunId, kind: "stories" | "fuzz") =>
  Story.as(
    "ci",
    Db.when(ci.open, { ...runContext({ kind }), run }),
    Db.settled("Committed"),
    Db.when(ci.declare, {
      org: orgA,
      run,
      artifacts: [
        { name: "story.json", mime: "application/json", bytes: 900, sha256: "1".repeat(64) },
        { name: "2.png", mime: "image/png", bytes: 4_000, sha256: "2".repeat(64) },
      ],
    }),
    Db.settled("Committed"),
  );

const recorded = (
  run: RunId,
  slug: string,
  status: "passed" | "failed",
  frames: ReadonlyArray<FrameStatus | null>,
) =>
  Story.as(
    "ci",
    Db.when(ci.story, {
      org: orgA,
      run,
      story: report(slug, status, run),
      summary: summarised(status, frames),
      frames: frames.some((frame) => frame !== null) ? [`${run}.2`] : [],
    }),
    Db.settled("Committed"),
  );

const completed = (run: RunId) =>
  Story.as("ci", Db.when(ci.complete, { org: orgA, run }), Db.settled("Committed"));

describe("Story runs", () => {
  it("are runs of kind stories that carry only story reports, charged as result rows", () =>
    console(people)(
      ...history,
      opened(run1, "stories"),
      recorded(run1, "rename", "passed", [null, "matched", "created"]),
      Story.as(
        "ci",
        Db.when(ci.record, { org: orgA, run: run1, kind: "fuzz", parts: [], ...noCounts }),
        Db.rejected(new KindMismatch({ expected: "stories" })),
      ),
      completed(run1),
      Db.then(
        runs.get({ run: run1 }),
        ([row]) =>
          row?.kind === "stories" &&
          row.outcome === "passed" &&
          row.summary.stories.passed === 1 &&
          row.summary.stories.failed === 0,
      ),
      // a report is charged like one results batch
      Db.then(billing.get({ org: orgA }), ([row]) => row?.usage.resultRows === 50),
      opened(run2, "fuzz"),
      completed(run2),
      Db.then(runs.list({ org: orgA, kind: "stories" }), [{ id: run1, kind: "stories" }]),
    ));

  it("fail when a story failed, counting each slug's latest report", () =>
    console(people)(
      ...history,
      opened(run1, "fuzz"),
      recorded(run1, "rename", "failed", [null, "mismatch"]),
      Db.then(
        runs.get({ run: run1 }),
        ([row]) => row?.outcome === "running" && row.summary.stories.failed === 1,
      ),
      // the same story again, passing: it replaces the failed report
      recorded(run1, "rename", "passed", [null, "matched"]),
      recorded(run1, "delete", "failed", [null, "missing"]),
      completed(run1),
      Db.then(
        runs.get({ run: run1 }),
        ([row]) =>
          row?.outcome === "failed" &&
          row.summary.stories.passed === 1 &&
          row.summary.stories.failed === 1,
      ),
    ));

  it("count their frames by how they compared with the baselines", () =>
    console(people)(
      ...history,
      opened(run1, "stories"),
      recorded(run1, "rename", "passed", ["matched", "matched", "created", null]),
      recorded(run1, "pin", "passed", ["updated"]),
      recorded(run1, "delete", "failed", ["mismatch", "missing"]),
      completed(run1),
      Db.then(runs.get({ run: run1 }), [
        {
          outcome: "failed",
          summary: {
            tests: { passed: 0, failed: 0, flaky: 0, skipped: 0 },
            cases: { ok: 0, overflow: 0, crash: 0, a11y: 0 },
            traces: { passed: 0, failed: 0 },
            stories: {
              passed: 2,
              failed: 1,
              frames: { matched: 2, created: 1, updated: 1, missing: 1, mismatch: 1 },
            },
            artifacts: 2,
            snapshots: { unchanged: 0, changed: 0, new: 0, removed: 0, "schema-changed": 0 },
          },
        },
      ]),
    ));
});
