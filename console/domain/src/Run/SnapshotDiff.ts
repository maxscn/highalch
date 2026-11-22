import * as Schema from "effect/Schema";
import { emptySnapshots, type SnapshotCounts, type SubjectTally } from "../Subject/Subject.ts";

/**
 * Snapshot comparison: the pure rules. Items are read as JSON from stored results; only the
 * fields comparison needs are decoded (anything else passes through untouched).
 */

const SubjectRef = Schema.Struct({
  kind: Schema.Literals(["component", "part", "page"]),
  name: Schema.String,
});
type SubjectRef = typeof SubjectRef.Type;

export const CaseItem = Schema.Struct({
  subject: SubjectRef,
  schemaHash: Schema.String,
  case: Schema.Struct({
    seed: Schema.Number,
    index: Schema.Number,
    outcome: Schema.String,
    capture: Schema.optionalKey(Schema.Struct({ artifactId: Schema.String })),
  }),
});
export const TraceItem = Schema.Struct({
  name: Schema.String,
  subject: SubjectRef,
  schemaHash: Schema.String,
  seed: Schema.Number,
  failure: Schema.NullOr(Schema.Json),
  steps: Schema.Array(
    Schema.Struct({ index: Schema.Number, captureArtifactId: Schema.optionalKey(Schema.String) }),
  ),
});
export const TestItem = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  status: Schema.String,
  subject: Schema.optionalKey(SubjectRef),
  attempts: Schema.Array(
    Schema.Struct({
      attachments: Schema.Array(
        Schema.Struct({ name: Schema.String, kind: Schema.String, artifactId: Schema.String }),
      ),
    }),
  ),
});
type CaseItem = typeof CaseItem.Type;
type TraceItem = typeof TraceItem.Type;
type TestItem = typeof TestItem.Type;

export type Status = keyof SnapshotCounts;

export interface Snapshot {
  readonly status: Status;
  readonly baselineRunId?: string;
  readonly baselineArtifactId?: string;
}

const ref = (s: SubjectRef) => `${s.kind}/${s.name}`;

/** Identity of a fuzz case (subject, seed, index). */
export const caseKey = (c: { subject: SubjectRef; case: { seed: number; index: number } }) =>
  `c|${ref(c.subject)}|${c.case.seed}|${c.case.index}`;
/** Identity of a trace (subject, name, seed); steps add the step index. */
export const traceKey = (t: { subject: SubjectRef; name: string; seed: number }) =>
  `t|${ref(t.subject)}|${t.name}|${t.seed}`;
export const stepKey = (t: { subject: SubjectRef; name: string; seed: number }, index: number) =>
  `${traceKey(t)}|${index}`;
/** Identity of a Playwright test (project, id); screenshots add the attachment name. */
export const testKey = (t: { project: string; id: string }) => `p|${t.project}|${t.id}`;
export const attachmentKey = (t: { project: string; id: string }, name: string) =>
  `${testKey(t)}|${name}`;

/** Attachment kinds compared as visual snapshots. */
export const visualKinds: ReadonlySet<string> = new Set(["screenshot", "snapshot-actual"]);

/** The most significant status of several captures. */
export const worst = (statuses: ReadonlyArray<Status>): Status | undefined =>
  (["schema-changed", "changed", "removed", "new", "unchanged"] as const).find((s) =>
    statuses.includes(s),
  );

export interface Loaded {
  readonly cases: ReadonlyArray<{ readonly raw: unknown; readonly item: CaseItem }>;
  readonly traces: ReadonlyArray<{ readonly raw: unknown; readonly item: TraceItem }>;
  readonly tests: ReadonlyArray<{ readonly raw: unknown; readonly item: TestItem }>;
}

interface Capture {
  readonly sha: string | undefined;
  readonly artifactId: string;
  readonly subject: string | undefined;
  readonly schemaHash: string | undefined;
}

const decode = <S extends Schema.Top>(schema: S, raw: unknown) => {
  const result = Schema.decodeUnknownOption(schema as any)(raw);
  return result._tag === "Some" ? (result.value as S["Type"]) : undefined;
};

/** Decodes stored items of each part, skipping anything that is not an item. */
export const parse = (
  parts: ReadonlyArray<{ part: string; items: ReadonlyArray<unknown> }>,
): Loaded => {
  const out = { cases: [] as Array<any>, traces: [] as Array<any>, tests: [] as Array<any> };
  for (const { part, items } of parts)
    for (const raw of items) {
      if (part === "cases") {
        const item = decode(CaseItem, raw);
        if (item) out.cases.push({ raw, item });
      } else if (part === "traces") {
        const item = decode(TraceItem, raw);
        if (item) out.traces.push({ raw, item });
      } else if (part === "tests") {
        const item = decode(TestItem, raw);
        if (item) out.tests.push({ raw, item });
      }
    }
  return out;
};

const capturesOf = (loaded: Loaded, sha: ReadonlyMap<string, string>) => {
  const captures = new Map<string, Capture>();
  const schemas = new Map<string, string>();
  for (const { item } of loaded.cases) {
    schemas.set(ref(item.subject), item.schemaHash);
    if (item.case.capture)
      captures.set(caseKey(item), {
        sha: sha.get(item.case.capture.artifactId),
        artifactId: item.case.capture.artifactId,
        subject: ref(item.subject),
        schemaHash: item.schemaHash,
      });
  }
  for (const { item } of loaded.traces) {
    schemas.set(ref(item.subject), item.schemaHash);
    for (const step of item.steps)
      if (step.captureArtifactId)
        captures.set(stepKey(item, step.index), {
          sha: sha.get(step.captureArtifactId),
          artifactId: step.captureArtifactId,
          subject: ref(item.subject),
          schemaHash: item.schemaHash,
        });
  }
  for (const { item } of loaded.tests) {
    const last = item.attempts[item.attempts.length - 1];
    for (const attachment of last?.attachments ?? [])
      if (visualKinds.has(attachment.kind))
        captures.set(attachmentKey(item, attachment.name), {
          sha: sha.get(attachment.artifactId),
          artifactId: attachment.artifactId,
          subject: item.subject ? ref(item.subject) : undefined,
          schemaHash: undefined,
        });
  }
  return { captures, schemas };
};

export interface Side {
  readonly loaded: Loaded;
  /** artifact id → body digest */
  readonly sha: ReadonlyMap<string, string>;
}

export interface Diff {
  readonly snapshots: Readonly<Record<string, Snapshot>>;
  readonly counts: SnapshotCounts;
  readonly subjects: ReadonlyArray<SubjectTally>;
  /** Baseline items with no counterpart, ready to list against the new run. */
  readonly removed: {
    readonly cases: ReadonlyArray<unknown>;
    readonly traces: ReadonlyArray<unknown>;
    readonly tests: ReadonlyArray<unknown>;
  };
}

/**
 * Compares every capture of `current` with the capture of the same identity in `baseline`:
 * `new` without one (or without a baseline run), `schema-changed` when the subject's
 * generator changed, else `unchanged` / `changed` by body digest. Baseline items missing
 * from the run are `removed`.
 */
export const diff = (current: Side, baseline: (Side & { readonly run: string }) | null): Diff => {
  const now = capturesOf(current.loaded, current.sha);
  const before = baseline ? capturesOf(baseline.loaded, baseline.sha) : undefined;
  const base = baseline ? { baselineRunId: baseline.run } : {};
  const snapshots: Record<string, Snapshot> = {};
  const counts: Record<Status, number> = { ...emptySnapshots };
  const tallies = new Map<
    string,
    { -readonly [K in keyof SubjectTally]: SubjectTally[K] } & { snapshots: Record<Status, number> }
  >();
  const tally = (subject: SubjectRef | undefined, schemaHash: string | null) => {
    if (!subject) return undefined;
    const entry = tallies.get(ref(subject)) ?? {
      kind: subject.kind,
      name: subject.name,
      items: 0,
      failures: 0,
      snapshots: { ...emptySnapshots },
      schemaHash,
    };
    tallies.set(ref(subject), entry);
    return entry;
  };

  for (const [key, capture] of now.captures) {
    const previous = before?.captures.get(key);
    const snapshot: Snapshot = !before
      ? { status: "new" }
      : capture.subject !== undefined &&
          capture.schemaHash !== undefined &&
          before.schemas.has(capture.subject) &&
          before.schemas.get(capture.subject) !== capture.schemaHash
        ? {
            status: "schema-changed",
            ...base,
            ...(previous ? { baselineArtifactId: previous.artifactId } : {}),
          }
        : !previous
          ? { status: "new", ...base }
          : {
              status:
                previous.sha !== undefined && previous.sha === capture.sha
                  ? "unchanged"
                  : "changed",
              ...base,
              baselineArtifactId: previous.artifactId,
            };
    snapshots[key] = snapshot;
    counts[snapshot.status]++;
  }

  for (const { item } of current.loaded.cases) {
    const entry = tally(item.subject, item.schemaHash);
    if (!entry) continue;
    entry.items++;
    if (item.case.outcome !== "ok") entry.failures++;
    const s = snapshots[caseKey(item)];
    if (s) entry.snapshots[s.status]++;
  }
  for (const { item } of current.loaded.traces) {
    const entry = tally(item.subject, item.schemaHash);
    if (!entry) continue;
    entry.items++;
    if (item.failure !== null) entry.failures++;
    for (const step of item.steps) {
      const s = snapshots[stepKey(item, step.index)];
      if (s) entry.snapshots[s.status]++;
    }
  }
  for (const { item } of current.loaded.tests) {
    const entry = tally(item.subject, null);
    if (!entry) continue;
    entry.items++;
    if (item.status === "failed") entry.failures++;
    const last = item.attempts[item.attempts.length - 1];
    for (const attachment of last?.attachments ?? []) {
      const s = snapshots[attachmentKey(item, attachment.name)];
      if (s) entry.snapshots[s.status]++;
    }
  }

  const removed = {
    cases: [] as Array<unknown>,
    traces: [] as Array<unknown>,
    tests: [] as Array<unknown>,
  };
  if (baseline) {
    const gone = (artifactId?: string) => ({
      status: "removed" as const,
      baselineRunId: baseline.run,
      ...(artifactId ? { baselineArtifactId: artifactId } : {}),
    });
    const keep = <A>(list: ReadonlyArray<{ item: A }>, key: (a: A) => string) =>
      new Set(list.map(({ item }) => key(item)));
    const cases = keep(current.loaded.cases, caseKey);
    for (const { raw, item } of baseline.loaded.cases)
      if (!cases.has(caseKey(item))) {
        removed.cases.push({ ...(raw as object), snapshot: gone(item.case.capture?.artifactId) });
        counts.removed++;
        const e = tally(item.subject, item.schemaHash);
        if (e) e.snapshots.removed++;
      }
    const traces = keep(current.loaded.traces, traceKey);
    for (const { raw, item } of baseline.loaded.traces)
      if (!traces.has(traceKey(item))) {
        removed.traces.push({ ...(raw as object), snapshot: gone() });
        counts.removed++;
        const e = tally(item.subject, item.schemaHash);
        if (e) e.snapshots.removed++;
      }
    const tests = keep(current.loaded.tests, testKey);
    for (const { raw, item } of baseline.loaded.tests)
      if (!tests.has(testKey(item))) {
        removed.tests.push({ ...(raw as object), snapshot: gone() });
        counts.removed++;
        const e = tally(item.subject, null);
        if (e) e.snapshots.removed++;
      }
  }
  return { snapshots, counts, subjects: [...tallies.values()], removed };
};
