import { describe, expect, it } from "vite-plus/test";
import { Db } from "@highalch/story/tanstack-db";
import { chargedStoryRows } from "../src/Billing/Plan.ts";
import { billing, stories } from "../src/Console.collections.ts";
import { RunNotOpen } from "../src/Run/RunNotOpen.rejection.ts";
import { UnknownArtifact } from "../src/Run/UnknownArtifact.rejection.ts";
import type { StoryHeader, StorySummary } from "../src/Story/Story.values.ts";
import {
  acmeCrm,
  alice,
  apiKey,
  ask,
  bearer,
  ci,
  console,
  crm,
  existingProject,
  openedRun,
  orgA,
  paidOrganization,
  run1,
  session,
  Story,
} from "./support.ts";

const crmKey = apiKey(crm, "k1");

const people = [
  [orgA, session(alice)],
  ["ci", bearer(crmKey.token)],
] as const;

/** CI declared the story's `story.json` (`run-1.1`) and one frame (`run-1.2`). */
const declared = Story.as(
  "ci",
  Db.when(ci.declare, {
    org: orgA,
    run: run1,
    artifacts: [
      { name: "story.json", mime: "application/json", bytes: 900, sha256: "1".repeat(64) },
      { name: "03-render.png", mime: "image/png", bytes: 4_000, sha256: "2".repeat(64) },
    ],
  }),
  Db.settled("Committed"),
);

const story = (status: "passed" | "failed", report = "run-1.1"): StoryHeader => ({
  slug: "rename-is-rejected",
  name: "rename is rejected",
  test: { file: "tests/notes.test.ts", name: "rename is rejected" },
  status,
  durationMs: 41,
  host: "memory",
  scope: "acc-1",
  clock: "manual",
  invariants: ["noFlickerBack", "nothingPending"],
  failure: status === "failed" ? { step: 3, reason: "does not show what was expected" } : null,
  explore: null,
  report,
});

const summary = (failed: number): StorySummary => ({
  steps: { passed: 3 - failed, failed, notRun: 0 },
  kinds: ["given", "render", "when"],
  frames: { matched: 1, created: 0, updated: 0, missing: 0, mismatch: 0 },
});

const recording = (status: "passed" | "failed", report = "run-1.1", frames = ["run-1.2"]) => ({
  org: orgA,
  run: run1,
  story: story(status, report),
  summary: summary(status === "failed" ? 1 : 0),
  frames,
});

/** The bytes a recording's summary is charged by. */
const encoded = (status: "passed" | "failed") =>
  new TextEncoder().encode(
    JSON.stringify({ story: story(status), summary: summary(status === "failed" ? 1 : 0) }),
  ).byteLength;

describe("Story reports", () => {
  it("keep one row per story, its steps summarised; a slug recorded again replaces it", () =>
    console(people).with({ rules: Db.rules })(
      paidOrganization(orgA, alice),
      ...existingProject(crm, orgA, { repository: acmeCrm, keys: [crmKey] }),
      ...openedRun(run1, { branch: "feature", pr: 7 }),
      declared,
      Story.as("ci", Db.when(ci.story, recording("passed")), Db.settled("Committed")),
      Db.then(stories.list({ run: run1 }), [
        {
          id: "run-1/rename-is-rejected",
          status: "passed",
          branch: "feature",
          pr: 7,
          steps: { passed: 3, failed: 0, notRun: 0 },
          kinds: ["given", "render", "when"],
          frames: { matched: 1, created: 0, updated: 0, missing: 0, mismatch: 0 },
          report: "run-1.1",
        },
      ]),
      // recorded again (a retried test): the latest report replaces it
      Story.as("ci", Db.when(ci.story, recording("failed")), Db.settled("Committed")),
      Db.then(stories.list({ run: run1 }), [
        {
          status: "failed",
          steps: { passed: 2, failed: 1, notRun: 0 },
          failure: { step: 3, reason: "does not show what was expected" },
        },
      ]),
      ask(
        "its steps are in its report, linked like any artifact",
        (api) => api.ArtifactLinks({ run: run1, ids: ["run-1.1"] }),
        ([link]) => expect(link?.id).toBe("run-1.1"),
      ),
      // each report is charged like a results batch (a little more past 500 bytes)
      Db.then(
        billing.get({ org: orgA }),
        ([row]) =>
          row?.usage.resultRows ===
          chargedStoryRows({ bytes: encoded("passed") }) +
            chargedStoryRows({ bytes: encoded("failed") }),
      ),
    ));

  it("refuses a report that names an artifact the run never declared, or a completed run", () =>
    console(people)(
      paidOrganization(orgA, alice),
      ...existingProject(crm, orgA, { repository: acmeCrm, keys: [crmKey] }),
      ...openedRun(run1),
      declared,
      Story.as(
        "ci",
        Db.when(ci.story, recording("passed", "run-1.9")),
        Db.rejected(new UnknownArtifact({ artifact: "run-1.9" })),
        Db.when(ci.story, recording("passed", "run-1.1", ["run-2.1"])),
        Db.rejected(new UnknownArtifact({ artifact: "run-2.1" })),
        Db.when(ci.complete, { org: orgA, run: run1 }),
        Db.settled("Committed"),
        Db.when(ci.story, recording("passed")),
        Db.rejected(new RunNotOpen()),
      ),
      Db.then(stories.list({ run: run1 }), []),
    ));

  it("are charged about one results batch, more only for a large summary", () => {
    expect(encoded("failed")).toBeLessThan(600);
    expect(chargedStoryRows({ bytes: encoded("failed") })).toBeLessThanOrEqual(60);
    expect(chargedStoryRows({ bytes: 400 })).toBe(50);
    expect(chargedStoryRows({ bytes: 5_600 })).toBe(560);
  });
});
