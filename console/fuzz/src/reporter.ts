import {
  open,
  Results,
  type Failure,
  type File,
  type LocalReason,
  type Options,
} from "@highalch/console-client";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { Capture } from "./adapter.ts";
import type { Case } from "./cases.ts";
import type { Run } from "./run.ts";

export interface ReporterOptions extends Options {
  /** Reject `flush()` with the typed failure instead of resolving `{ status: "failed" }`. Default false. */
  readonly strict?: boolean;
  /** Receives one-line status and failure messages (never credentials). Default `console.warn`. */
  readonly log?: (message: string) => void;
}

export interface AddMeta {
  /** App state that produced the capture. */
  readonly state?: unknown;
  /** Default `"ok"`. */
  readonly outcome?: Results.Outcome;
  readonly message?: string;
}

export type Flushed =
  | { readonly status: "uploaded"; readonly runId: string; readonly org: string }
  | {
      readonly status: "written";
      readonly runId: string;
      readonly dir: string;
      readonly reason: LocalReason;
    }
  | { readonly status: "empty" }
  | { readonly status: "failed"; readonly error: Failure };

export interface Reporter {
  /** Collects a case with its capture. Nothing is sent until {@link Reporter.flush}. */
  add<T>(c: Case<T>, capture?: Capture, meta?: AddMeta): void;
  /** Collects an action trace from `Fuzz.run` (with its step captures and failure). */
  trace<S, A>(run: Run<S, A>): void;
  /** Uploads (or writes to `.highalch/`) everything collected, once. */
  flush(): Promise<Flushed>;
}

const json = (value: unknown): Results.Case["value"] =>
  JSON.parse(
    JSON.stringify(value ?? null, (_, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ) ?? "null",
  ) as Results.Case["value"];

const file = (capture: Capture, name: string): File => ({
  name: `${name}.${capture.kind === "html" ? "html" : "png"}`,
  mime: capture.mime,
  body: capture.body,
});

/** What a reporter collected until `flush`. */
interface Collected {
  readonly cases: ReadonlyArray<{
    readonly c: Case<unknown>;
    readonly capture?: Capture;
    readonly meta: AddMeta;
  }>;
  readonly traces: ReadonlyArray<Run<unknown, unknown>>;
}

/**
 * Reports collected cases and traces to HighAlch Console (a fuzz run: its captures as artifacts,
 * cases and traces as results objects), or writes them to `.highalch/`. The Effect core of
 * {@link reporter}.
 */
export const send = Effect.fn("Console.send")(function* (
  options: ReporterOptions,
  collected: Collected,
  log: (message: string) => void,
) {
  const upload = yield* open(options, "fuzz");
  const captures: Array<{ capture: Capture; name: string }> = [];
  for (const { c, capture } of collected.cases)
    if (capture) captures.push({ capture, name: `${c.name}-${c.id.replace(/:/g, "-")}` });
  for (const trace of collected.traces)
    for (const step of trace.trace)
      if (step.capture)
        captures.push({
          capture: step.capture,
          name: `${trace.name}-${trace.seed}-step-${step.index}`,
        });
  const ids = yield* upload.artifacts(captures.map(({ capture, name }) => file(capture, name)));
  const idOf = new Map(captures.map(({ capture }, index) => [capture, ids[index] ?? ""]));

  const cases: Array<Results.CaseItem> = collected.cases.map(({ c, capture, meta }) => {
    const artifactId = capture ? idOf.get(capture) : undefined;
    return {
      name: c.name,
      subject: c.subject,
      schemaHash: c.schemaHash,
      case: {
        id: c.id,
        index: c.index,
        seed: c.seed,
        path: c.path,
        value: json(c.value),
        edges: c.edges,
        outcome: meta.outcome ?? "ok",
        ...(meta.message === undefined ? {} : { message: meta.message }),
        ...("state" in meta ? { state: json(meta.state) } : {}),
        ...(capture && artifactId ? { capture: { artifactId, kind: capture.kind } } : {}),
      },
    };
  });
  const traces: Array<Results.TraceItem> = collected.traces.map((trace) => ({
    name: trace.name,
    subject: trace.subject,
    schemaHash: trace.schemaHash,
    seed: trace.seed,
    initial: json(trace.initial),
    steps: trace.trace.map((step) => {
      const artifactId = step.capture ? idOf.get(step.capture) : undefined;
      return {
        index: step.index,
        action: json(step.action),
        state: json(step.state),
        ...(step.capture && artifactId
          ? { captureArtifactId: artifactId, captureKind: step.capture.kind }
          : {}),
      };
    }),
    failure: trace.failure
      ? {
          message: trace.failure.message,
          ...(trace.failure.error instanceof Error && trace.failure.error.stack
            ? { stack: trace.failure.error.stack }
            : {}),
          index: trace.failure.index,
          counterexample: trace.failure.counterexample.map(json),
          seed: trace.failure.seed,
          path: trace.failure.path,
          shrinks: trace.failure.shrinks,
        }
      : null,
  }));

  yield* upload.results({ cases, traces });

  const outcome = yield* upload.complete();
  if (outcome.mode === "remote")
    return { status: "uploaded", runId: outcome.runId, org: outcome.org } satisfies Flushed;
  log(
    `[highalch] wrote ${collected.cases.length} cases and ${collected.traces.length} traces to ${outcome.dir}`,
  );
  return {
    status: "written",
    runId: outcome.runId,
    dir: outcome.dir,
    reason: outcome.reason,
  } satisfies Flushed;
}, Effect.scoped);

/**
 * Collects fuzz cases and traces and reports them to HighAlch Console. Uploads with
 * `HIGHALCH_URL` plus `HIGHALCH_API_KEY` or GitHub Actions OIDC; otherwise writes the same
 * objects to `.highalch/`. `flush()` is the Promise facade over {@link send} for plain test files.
 */
export const reporter = (options: ReporterOptions = {}): Reporter => {
  const log = options.log ?? ((message: string) => console.warn(message));
  const collected = Ref.makeUnsafe<Collected>({ cases: [], traces: [] });
  const flush = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(collected, { cases: [], traces: [] });
    if (current.cases.length === 0 && current.traces.length === 0)
      return { status: "empty" } satisfies Flushed;
    return yield* send(options, current, log).pipe(
      Effect.catch((error: Failure): Effect.Effect<Flushed, Failure> => {
        if (options.strict) return Effect.fail(error);
        log(`[highalch] results not reported (${error._tag})`);
        return Effect.succeed({ status: "failed", error });
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer));
  return {
    add(c, capture, meta = {}) {
      Effect.runSync(
        Ref.update(collected, (s) => ({
          ...s,
          cases: [...s.cases, { c, ...(capture ? { capture } : {}), meta }],
        })),
      );
    },
    trace(run) {
      Effect.runSync(Ref.update(collected, (s) => ({ ...s, traces: [...s.traces, run] })));
    },
    flush: () => Effect.runPromise(flush),
  };
};
