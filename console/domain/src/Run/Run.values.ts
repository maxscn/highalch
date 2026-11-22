import * as Schema from "effect/Schema";
import { Count } from "../Ids.ts";
import { emptySnapshots, SnapshotCounts } from "../Subject/Subject.ts";

/**
 * What a run reports: Playwright tests, fuzz cases and traces, or only story reports
 * (`stories`: a `vp test` run with HighAlch reports). Runs of any kind may carry stories.
 */
export const Kind = Schema.Literals(["playwright", "fuzz", "stories"]);
export type Kind = typeof Kind.Type;

export const TestCounts = Schema.Struct({
  passed: Count,
  failed: Count,
  flaky: Count,
  skipped: Count,
});
export const CaseCounts = Schema.Struct({ ok: Count, overflow: Count, crash: Count, a11y: Count });
export const TraceCounts = Schema.Struct({ passed: Count, failed: Count });

/** Screen frames of stories by how they compared with their reviewed baselines. */
export const FrameCounts = Schema.Struct({
  matched: Count,
  created: Count,
  updated: Count,
  missing: Count,
  mismatch: Count,
});
export type FrameCounts = typeof FrameCounts.Type;

export const emptyFrames: FrameCounts = {
  matched: 0,
  created: 0,
  updated: 0,
  missing: 0,
  mismatch: 0,
};

/** A run's stories (each slug's latest report) by status, and their frames. */
export const StoryCounts = Schema.Struct({ passed: Count, failed: Count, frames: FrameCounts });
export type StoryCounts = typeof StoryCounts.Type;

export const emptyStories: StoryCounts = { passed: 0, failed: 0, frames: emptyFrames };

export const Summary = Schema.Struct({
  tests: TestCounts,
  cases: CaseCounts,
  traces: TraceCounts,
  stories: StoryCounts,
  artifacts: Count,
  snapshots: SnapshotCounts,
});
export type Summary = typeof Summary.Type;

export const emptySummary: Summary = {
  tests: { passed: 0, failed: 0, flaky: 0, skipped: 0 },
  cases: { ok: 0, overflow: 0, crash: 0, a11y: 0 },
  traces: { passed: 0, failed: 0 },
  stories: emptyStories,
  artifacts: 0,
  snapshots: emptySnapshots,
};

/**
 * How a run went: `running` until it completes, then `failed` when anything it reported failed
 * (a test, a fuzz case that crashed, overflowed or broke accessibility, a trace, a story: a
 * missing or mismatched frame fails its story), else `passed`. Changed snapshots are for
 * review, not failures.
 */
export const Outcome = Schema.Literals(["running", "passed", "failed"]);
export type Outcome = typeof Outcome.Type;

export const failures = (summary: Summary) =>
  summary.tests.failed +
  summary.cases.crash +
  summary.cases.overflow +
  summary.cases.a11y +
  summary.traces.failed +
  summary.stories.failed;

export const outcomeOf = (run: {
  readonly status: "running" | "completed";
  readonly summary: Summary;
}): Outcome =>
  run.status === "running" ? "running" : failures(run.summary) > 0 ? "failed" : "passed";

const add = <K extends string>(a: Record<K, number>, b: Record<K, number>) =>
  Object.fromEntries(
    Object.entries(a).map(([k, v]) => [k, (v as number) + (b[k as K] ?? 0)]),
  ) as Record<K, number>;

export const addSummary = (
  a: Summary,
  b: Pick<Summary, "tests" | "cases" | "traces">,
  artifacts = 0,
): Summary => ({
  tests: add(a.tests, b.tests),
  cases: add(a.cases, b.cases),
  traces: add(a.traces, b.traces),
  stories: a.stories,
  artifacts: a.artifacts + artifacts,
  snapshots: a.snapshots,
});

/** An artifact a client declares before uploading its body. */
export const ArtifactUpload = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  mime: Schema.String.check(Schema.isMaxLength(255)),
  bytes: Count,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type ArtifactUpload = typeof ArtifactUpload.Type;

/** An accepted artifact: its id (`<run>.<n>`) and position. */
export const AcceptedArtifact = Schema.Struct({
  ...ArtifactUpload.fields,
  id: Schema.String,
  index: Count,
});
export type AcceptedArtifact = typeof AcceptedArtifact.Type;

/** An artifact as declared: `upload` false when the organisation already stores its body. */
export const ArtifactDeclaration = Schema.Struct({
  name: Schema.String,
  mime: Schema.String,
  bytes: Count,
  sha256: Schema.String,
  upload: Schema.Boolean,
  generation: Count,
});
export type ArtifactDeclaration = typeof ArtifactDeclaration.Type;

export const DeclaredArtifact = Schema.Struct({
  ...ArtifactDeclaration.fields,
  id: Schema.String,
  index: Count,
});
export type DeclaredArtifact = typeof DeclaredArtifact.Type;

/**
 * One stored results object (R2), how many items it holds, and how many of them were charged:
 * server-side processing reads at most `charged` items of it.
 */
export const ResultPart = Schema.Struct({
  /** `snapshots`: the run's snapshot map (item key → snapshot), written at completion. */
  part: Schema.Literals(["tests", "cases", "traces", "snapshots"]),
  key: Schema.String,
  count: Count,
  charged: Count,
});
export type ResultPart = typeof ResultPart.Type;

export const PartKind = Schema.Literals(["tests", "cases", "traces"]);
export type PartKind = typeof PartKind.Type;

/** A results object a client uploads: which part, its JSON's digest and size, and its items. */
export const ResultUpload = Schema.Struct({
  part: PartKind,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  bytes: Count,
  count: Count,
});
export type ResultUpload = typeof ResultUpload.Type;

/** Where a run's uploaded results object is stored: derived, never chosen by the client. */
export const resultKey = (org: string, run: string, upload: { part: string; sha256: string }) =>
  `r/${org}/${run}/${upload.sha256}.${upload.part}.json`;

/**
 * An upload to verify once its link expired: a blob generation (`generation`) or a results
 * object (`generation: null`), at `key`, with the size and digest it was declared with.
 */
export const PendingUpload = Schema.Struct({
  key: Schema.String,
  sha256: Schema.String,
  bytes: Count,
  generation: Schema.NullOr(Count),
});
export type PendingUpload = typeof PendingUpload.Type;

export const RunStatus = Schema.Literals(["running", "completed"]);

export const CompletionReason = Schema.Literals(["client", "expired"]);

export const Person = Schema.Struct({ login: Schema.String, name: Schema.String });

/** Commit metadata reported by the uploader (display only). */
export const CommitInfo = Schema.Struct({
  message: Schema.String,
  author: Person,
  committedAt: Schema.String,
});
export type CommitInfo = typeof CommitInfo.Type;

/** Pull request metadata reported by the uploader (display only). */
export const PullInfo = Schema.Struct({
  title: Schema.String,
  author: Person,
  base: Schema.String,
  baseSha: Schema.String,
  state: Schema.Literals(["open", "merged", "closed"]),
});
export type PullInfo = typeof PullInfo.Type;
