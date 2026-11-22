import type { StoryHeader, StorySummary } from "@highalch/console-domain/Story/Story.values";
import { StoryReport } from "./StoryReport.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ReportInvalid, ReportUnreadable } from "./Errors.ts";

/**
 * Story reports: one `story.json` per story run, which `@highalch/story` is to write (story
 * reports are not on this base yet) into `<folder>/<slug>/story.json` next to the step frames
 * (PNGs). The client decodes a report with its own copy of the format (`./StoryReport.ts`), keeps
 * what HighAlch Console keeps of it (its header and the summary of its steps), and uploads the report itself (every step) whole as an
 * artifact, as it does the frames.
 */

export { StoryReport };

/** A report read from disk: its parsed fields, its own bytes and its frames' bytes by file. */
export interface StoryFiles {
  readonly path: string;
  readonly report: StoryReport;
  readonly body: Uint8Array;
  readonly frames: ReadonlyMap<string, Uint8Array>;
}

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(StoryReport));

/** Reads one `story.json` and the frames its steps name (a frame that is missing is left out). */
export const readStory = Effect.fn("Stories.read")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const body = yield* fs
    .readFile(path)
    .pipe(Effect.mapError((error) => new ReportUnreadable({ path, message: error.message })));
  const report = yield* decodeReport(new TextDecoder().decode(body)).pipe(
    Effect.mapError((error) => new ReportInvalid({ path, message: error.message })),
  );
  const frames = new Map<string, Uint8Array>();
  for (const file of framesOf(report)) {
    const frame = yield* fs.readFile(paths.join(paths.dirname(path), file)).pipe(Effect.option);
    if (frame._tag === "Some") frames.set(file, frame.value);
  }
  return { path, report, body, frames } satisfies StoryFiles;
});

/** Every `story.json` below `folder`, in path order. */
export const findStories = Effect.fn("Stories.find")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(folder, { recursive: true })
    .pipe(
      Effect.mapError((error) => new ReportUnreadable({ path: folder, message: error.message })),
    );
  return entries
    .filter((entry) => paths.basename(entry) === "story.json")
    .sort()
    .map((entry) => paths.join(folder, entry));
});

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** The frames a report's steps name, each once, in step order. */
export const framesOf = (report: StoryReport): ReadonlyArray<string> => [
  ...new Set(report.steps.flatMap((step) => (step.frame ? [step.frame.file] : []))),
];

/**
 * What `RecordStory` takes for a report: its header (within the bounds HighAlch Console keeps:
 * names 300, scope 200, 20 rule names of 100 in `invariants`, a failure reason of 1 000), the
 * summary of its steps, and the artifact ids its `story.json` (`report`) and frames (`frames`,
 * by file) were declared with. Every step stays in `story.json`. A hostless story has no scope or
 * clock (`""`, `manual`); an exploration's replay is kept as `explore` by the exploration's name
 * and the sequence's number (`model`, `path`, `of`). Frames an exploration's replay recorded
 * (`recorded`) count under no status.
 */
export const recordOf = (
  report: StoryReport,
  ids: { readonly report: string; readonly frames: ReadonlyMap<string, string> },
): {
  readonly story: StoryHeader;
  readonly summary: StorySummary;
  readonly frames: ReadonlyArray<string>;
} => {
  const steps = report.steps;
  const frames = steps.flatMap((step) => (step.frame ? [step.frame] : []));
  const framesWith = (status: (typeof frames)[number]["status"]) =>
    frames.filter((frame) => frame.status === status).length;
  return {
    story: {
      slug: report.slug,
      name: clip(report.name, 300),
      test:
        report.test === undefined
          ? null
          : { file: clip(report.test.file, 300), name: clip(report.test.name, 300) },
      status: report.status,
      durationMs: report.durationMs,
      host: report.host,
      scope: clip(report.scope ?? "", 200),
      clock: report.clock ?? "manual",
      invariants: report.rules.slice(0, 20).map((rule) => clip(rule.name, 100)),
      failure:
        report.failure === undefined
          ? null
          : { step: report.failure.step, reason: clip(report.failure.reason, 1_000) },
      explore:
        report.explore === undefined
          ? null
          : {
              model: clip(report.explore.name, 200),
              path: report.explore.index,
              of: report.explore.of,
            },
      report: ids.report,
    },
    summary: {
      steps: {
        passed: steps.filter((step) => step.status === "passed").length,
        failed: steps.filter((step) => step.status === "failed").length,
        notRun: steps.filter((step) => step.status === "not-run").length,
      },
      kinds: [...new Set(steps.map((step) => clip(step.kind, 50)))].slice(0, 20),
      frames: {
        matched: framesWith("matched"),
        created: framesWith("created"),
        updated: framesWith("updated"),
        missing: framesWith("missing"),
        mismatch: framesWith("mismatch"),
      },
    },
    frames: framesOf(report).flatMap((file) => {
      const id = ids.frames.get(file);
      return id === undefined ? [] : [id];
    }),
  };
};
