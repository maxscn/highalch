import * as Schema from "effect/Schema";

/**
 * The items CI uploads as a run's results objects (JSON arrays, one per part): Playwright tests
 * (`tests`), fuzz cases (`cases`) and action traces (`traces`). HighAlch Console stores them in
 * R2 as they are sent; the domain reads the fields snapshot comparison needs, the web app reads
 * the rest. The `snapshot` the old REST reads added is gone: comparison lives in the domain.
 */

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Millis = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
);
const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));

// ---------------------------------------------------------------- subjects

/** What a test, a fuzz set or a trace exercises. */
export const SubjectKind = Schema.Literals(["component", "part", "page"]);
export type SubjectKind = typeof SubjectKind.Type;

export const Subject = Schema.Struct({
  kind: SubjectKind,
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
});
export type Subject = typeof Subject.Type;

// ---------------------------------------------------------------- Playwright

export const Location = Schema.Struct({ file: Schema.String, line: Count, column: Count });
export type Location = typeof Location.Type;

/** An error thrown in a test attempt or step. `snippet` is Playwright's code frame. */
export const TestError = Schema.Struct({
  message: Schema.String,
  stack: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Location),
  snippet: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
});
export type TestError = typeof TestError.Type;

export interface Step {
  readonly title: string;
  readonly category: string;
  readonly startedAt: string;
  readonly duration: number;
  readonly location?: Location;
  readonly error?: TestError;
  readonly steps: ReadonlyArray<Step>;
}

/** A `test.step`, `expect`, hook, fixture or API call, with nested steps. */
export const Step = Schema.Struct({
  title: Schema.String,
  category: Schema.String,
  startedAt: Timestamp,
  duration: Millis,
  location: Schema.optionalKey(Location),
  error: Schema.optionalKey(TestError),
  steps: Schema.Array(Schema.suspend((): Schema.Codec<Step> => Step)),
}) satisfies Schema.Codec<Step>;

export const AttachmentKind = Schema.Literals([
  "screenshot",
  "video",
  "trace",
  "snapshot-expected",
  "snapshot-actual",
  "snapshot-diff",
  "other",
]);
export type AttachmentKind = typeof AttachmentKind.Type;

/** An attachment uploaded as an artifact of the run, by its artifact id. */
export const Attachment = Schema.Struct({
  name: Schema.String,
  kind: AttachmentKind,
  mime: Schema.String,
  artifactId: Id,
});
export type Attachment = typeof Attachment.Type;

export const AttemptStatus = Schema.Literals([
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
]);
export type AttemptStatus = typeof AttemptStatus.Type;

/** One execution of a test; `retry` is 0 for the first attempt. */
export const Attempt = Schema.Struct({
  retry: Count,
  status: AttemptStatus,
  startedAt: Timestamp,
  duration: Millis,
  workerIndex: Schema.Int,
  errors: Schema.Array(TestError),
  steps: Schema.Array(Step),
  attachments: Schema.Array(Attachment),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
});
export type Attempt = typeof Attempt.Type;

/** Final outcome across attempts: `flaky` = failed, then passed on a retry. */
export const TestStatus = Schema.Literals(["passed", "failed", "flaky", "skipped"]);
export type TestStatus = typeof TestStatus.Type;

export const Annotation = Schema.Struct({
  type: Schema.String,
  description: Schema.optionalKey(Schema.String),
});
export type Annotation = typeof Annotation.Type;

/** One Playwright test with its attempts: an item of a `tests` object. */
export const TestItem = Schema.Struct({
  /** Playwright's stable test id (the same across runs for the same test and project). */
  id: Schema.String,
  title: Schema.String,
  /** Describe-block titles leading to the test, outermost first. */
  titlePath: Schema.Array(Schema.String),
  file: Schema.String,
  line: Count,
  column: Count,
  /** Playwright project name, e.g. `chromium`. */
  project: Schema.String,
  browser: Schema.optionalKey(Schema.String),
  status: TestStatus,
  /** From a `highalch:component` / `highalch:part` / `highalch:page` annotation. */
  subject: Schema.optionalKey(Subject),
  expectedStatus: AttemptStatus,
  duration: Millis,
  retries: Count,
  tags: Schema.Array(Schema.String),
  annotations: Schema.Array(Annotation),
  attempts: Schema.Array(Attempt),
});
export type TestItem = typeof TestItem.Type;

/** Annotation types that set a test's subject; the description is the subject name. */
export const subjectAnnotations: Readonly<Record<string, SubjectKind>> = {
  "highalch:component": "component",
  "highalch:part": "part",
  "highalch:page": "page",
};

// ---------------------------------------------------------------- fuzzing

/** A deliberately awkward value inside a generated case, at an RFC 6901 `path`. */
export const Edge = Schema.Struct({ kind: Schema.String, path: Schema.String });
export type Edge = typeof Edge.Type;

export const CaptureKind = Schema.Literals(["html", "screenshot"]);
export type CaptureKind = typeof CaptureKind.Type;

export const Capture = Schema.Struct({ artifactId: Id, kind: CaptureKind });
export type Capture = typeof Capture.Type;

export const Outcome = Schema.Literals(["ok", "overflow", "crash", "a11y"]);
export type Outcome = typeof Outcome.Type;

/** One generated case. `seed` + `path` replay `value` with fast-check. */
export const Case = Schema.Struct({
  id: Schema.String,
  index: Count,
  seed: Schema.Int,
  path: Schema.String,
  value: Schema.Json,
  edges: Schema.Array(Edge),
  outcome: Outcome,
  message: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.Json),
  capture: Schema.optionalKey(Capture),
});
export type Case = typeof Case.Type;

/** `s1:<hex>` of a JSON Schema, or `v:<version>` of a raw arbitrary. */
export const SchemaHash = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));

/** One case with its set's name, subject and schema hash: an item of a `cases` object. */
export const CaseItem = Schema.Struct({
  name: Schema.String,
  subject: Subject,
  schemaHash: SchemaHash,
  case: Case,
});
export type CaseItem = typeof CaseItem.Type;

/** State after applying `action` at step `index`. */
export const TraceStep = Schema.Struct({
  index: Count,
  action: Schema.Json,
  state: Schema.Json,
  captureArtifactId: Schema.optionalKey(Id),
  captureKind: Schema.optionalKey(CaptureKind),
});
export type TraceStep = typeof TraceStep.Type;

/** Why an action sequence failed, with fast-check's shrunk counterexample. */
export const TraceFailure = Schema.Struct({
  message: Schema.String,
  stack: Schema.optionalKey(Schema.String),
  index: Count,
  counterexample: Schema.Array(Schema.Json),
  seed: Schema.Int,
  path: Schema.String,
  shrinks: Count,
});
export type TraceFailure = typeof TraceFailure.Type;

/** A seeded action sequence (`Fuzz.run`): an item of a `traces` object. */
export const TraceItem = Schema.Struct({
  name: Schema.String,
  subject: Subject,
  schemaHash: SchemaHash,
  seed: Schema.Int,
  initial: Schema.Json,
  steps: Schema.Array(TraceStep),
  failure: Schema.NullOr(TraceFailure),
});
export type TraceItem = typeof TraceItem.Type;

// ---------------------------------------------------------------- a batch

/** Items a reporter hands the client: each part is split into objects of at most 1 MB. */
export interface Items {
  readonly tests?: ReadonlyArray<TestItem>;
  readonly cases?: ReadonlyArray<CaseItem>;
  readonly traces?: ReadonlyArray<TraceItem>;
}

/** The counts a results batch reports for its items. */
export const countsOf = (items: Items) => {
  const tests = items.tests ?? [];
  const cases = items.cases ?? [];
  const traces = items.traces ?? [];
  const testsWith = (status: TestStatus) => tests.filter((t) => t.status === status).length;
  const casesWith = (outcome: Outcome) => cases.filter((c) => c.case.outcome === outcome).length;
  return {
    tests: {
      passed: testsWith("passed"),
      failed: testsWith("failed"),
      flaky: testsWith("flaky"),
      skipped: testsWith("skipped"),
    },
    cases: {
      ok: casesWith("ok"),
      overflow: casesWith("overflow"),
      crash: casesWith("crash"),
      a11y: casesWith("a11y"),
    },
    traces: {
      passed: traces.filter((t) => t.failure === null).length,
      failed: traces.filter((t) => t.failure !== null).length,
    },
  };
};
