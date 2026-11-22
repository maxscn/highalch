import * as Schema from "effect/Schema";
import { Count } from "../Ids.ts";
import { FrameCounts, type StoryCounts } from "../Run/Run.values.ts";

/**
 * What HighAlch Console keeps of a story report (`story.json`, `@highalch/console-client/StoryReport`): one
 * bounded summary per story. Every step, its world snapshot and its frame stay in the report
 * itself, an artifact of the run (`report`, read through `ArtifactLinks`), as the frames do.
 */

export const StoryStatus = Schema.Literals(["passed", "failed"]);
export type StoryStatus = typeof StoryStatus.Type;

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** The test a story ran in (`@highalch/story/vitest`). */
export const StoryTest = Schema.Struct({ file: Text(300), name: Text(300) });

/** Where a failed story failed (the full detail is in its report). */
export const StoryFailure = Schema.Struct({ step: Count, reason: Text(1_000) });

/** A generated story's path (`explore`; its events are in its report). */
export const StoryExplore = Schema.Struct({ model: Text(200), path: Count, of: Count });

/** One story of a run. `report` is the artifact id of its `story.json`. */
export const StoryHeader = Schema.Struct({
  slug: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  name: Text(300),
  test: Schema.NullOr(StoryTest),
  status: StoryStatus,
  durationMs: Schema.Number,
  host: Schema.Literals(["memory", "custom", "none"]),
  scope: Text(200),
  clock: Schema.Literals(["manual", "real"]),
  invariants: Schema.Array(Text(100)).check(Schema.isMaxLength(20)),
  failure: Schema.NullOr(StoryFailure),
  explore: Schema.NullOr(StoryExplore),
  report: Schema.String,
});
export type StoryHeader = typeof StoryHeader.Type;

/** A story's steps by status. */
export const StepCounts = Schema.Struct({ passed: Count, failed: Count, notRun: Count });
export type StepCounts = typeof StepCounts.Type;

/** What a story's steps add up to: their statuses, kinds and frames by status. */
export const StorySummary = Schema.Struct({
  steps: StepCounts,
  /** The step kinds it used (`given`, `when`, `render`, …), each once. */
  kinds: Schema.Array(Text(50)).check(Schema.isMaxLength(20)),
  frames: FrameCounts,
});
export type StorySummary = typeof StorySummary.Type;

/** One story's part of its run's story counts. */
export const storyCounts = (story: StoryHeader, summary: StorySummary): StoryCounts => ({
  passed: story.status === "passed" ? 1 : 0,
  failed: story.status === "failed" ? 1 : 0,
  frames: summary.frames,
});

const combine = (a: StoryCounts, b: StoryCounts, sign: 1 | -1): StoryCounts => ({
  passed: a.passed + sign * b.passed,
  failed: a.failed + sign * b.failed,
  frames: {
    matched: a.frames.matched + sign * b.frames.matched,
    created: a.frames.created + sign * b.frames.created,
    updated: a.frames.updated + sign * b.frames.updated,
    missing: a.frames.missing + sign * b.frames.missing,
    mismatch: a.frames.mismatch + sign * b.frames.mismatch,
  },
});

/** A run's story counts after a slug's report replaced its previous one (if any). */
export const replaceStory = (
  totals: StoryCounts,
  previous: StoryCounts | undefined,
  next: StoryCounts,
): StoryCounts => combine(previous === undefined ? totals : combine(totals, previous, -1), next, 1);
