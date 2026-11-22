import { relative, sep } from "node:path";
import { Results } from "@highalch/console-client";
import type {
  FullResult,
  Location,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

/** The parts of Playwright's reporter objects the conversion reads. */
export type Test = Pick<
  TestCase,
  "id" | "title" | "location" | "tags" | "annotations" | "expectedStatus" | "outcome" | "titlePath"
> & {
  readonly parent: {
    project():
      | { name: string; use: { browserName?: string; defaultBrowserType?: string } }
      | undefined;
  };
};
export type Result = Pick<
  TestResult,
  "retry" | "status" | "startTime" | "duration" | "workerIndex" | "errors" | "stdout" | "stderr"
> & { readonly steps: ReadonlyArray<Step>; readonly attachments: ReadonlyArray<Attachment> };
export type Step = Pick<
  TestStep,
  "title" | "category" | "startTime" | "duration" | "location" | "error"
> & {
  readonly steps: ReadonlyArray<Step>;
};
export type Attachment = TestResult["attachments"][number];
export type Run = Pick<FullResult, "status" | "startTime" | "duration">;

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
/** Strips terminal colors from Playwright messages. */
export const plain = (text: string) => text.replace(ansi, "");

export const kind = (
  attachment: Pick<Attachment, "name" | "contentType">,
): Results.AttachmentKind => {
  if (/-expected\.\w+$/.test(attachment.name)) return "snapshot-expected";
  if (/-actual\.\w+$/.test(attachment.name)) return "snapshot-actual";
  if (/-diff\.\w+$/.test(attachment.name)) return "snapshot-diff";
  if (attachment.name === "screenshot" || attachment.name.startsWith("screenshot"))
    return "screenshot";
  if (attachment.name === "video" || attachment.contentType.startsWith("video/")) return "video";
  if (attachment.name === "trace") return "trace";
  return "other";
};

const location = (root: string, value: Location): Results.Location => ({
  file: relative(root, value.file).split(sep).join("/"),
  line: value.line,
  column: value.column,
});

const error = (root: string, value: TestError): Results.TestError => ({
  message: plain(value.message ?? value.value ?? "Unknown error"),
  ...(value.stack === undefined ? {} : { stack: plain(value.stack) }),
  ...(value.location === undefined ? {} : { location: location(root, value.location) }),
  ...(value.snippet === undefined ? {} : { snippet: plain(value.snippet) }),
  ...(value.value === undefined ? {} : { value: value.value }),
});

const step = (root: string, value: Step): Results.Step => ({
  title: value.title,
  category: value.category,
  startedAt: value.startTime.toISOString(),
  duration: Math.max(0, value.duration),
  ...(value.location === undefined ? {} : { location: location(root, value.location) }),
  ...(value.error === undefined ? {} : { error: error(root, value.error) }),
  steps: value.steps.map((child) => step(root, child)),
});

const text = (chunks: ReadonlyArray<string | Buffer>) =>
  chunks.map((chunk) => (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).join("");

const status = (outcome: ReturnType<TestCase["outcome"]>): Results.TestStatus =>
  outcome === "expected"
    ? "passed"
    : outcome === "unexpected"
      ? "failed"
      : outcome === "flaky"
        ? "flaky"
        : "skipped";

/**
 * A test's subject from a `highalch:component` / `highalch:part` / `highalch:page` annotation (the
 * description is the subject name); the first such annotation wins.
 */
export const subjectOf = (
  annotations: ReadonlyArray<{ readonly type: string; readonly description?: string | undefined }>,
): { subject?: Results.Subject } => {
  for (const annotation of annotations) {
    const kind = Results.subjectAnnotations[annotation.type];
    const name = annotation.description?.trim();
    if (kind && name) return { subject: { kind, name: name.slice(0, 200) } };
  }
  return {};
};

/**
 * Converts one test and its attempts. `ids` maps each attachment (by identity) to the
 * uploaded artifact id; attachments without an id (unreadable files) are omitted.
 */
export const test = (
  root: string,
  value: Test,
  results: ReadonlyArray<Result>,
  ids: ReadonlyMap<Attachment, string>,
): Results.TestItem => {
  const project = value.parent.project();
  const browser = project?.use.browserName ?? project?.use.defaultBrowserType;
  const path = value.titlePath();
  return {
    id: value.id,
    title: value.title,
    titlePath: path.slice(3, -1),
    file: location(root, value.location).file,
    line: value.location.line,
    column: value.location.column,
    project: project?.name ?? "",
    ...(browser === undefined ? {} : { browser }),
    status: status(value.outcome()),
    ...subjectOf(value.annotations),
    expectedStatus: value.expectedStatus,
    duration: results.reduce((sum, result) => sum + Math.max(0, result.duration), 0),
    retries: Math.max(0, results.length - 1),
    tags: [...value.tags],
    annotations: value.annotations.map((annotation) => ({
      type: annotation.type,
      ...(annotation.description === undefined ? {} : { description: annotation.description }),
    })),
    attempts: results.map((result) => {
      const stdout = text(result.stdout);
      const stderr = text(result.stderr);
      return {
        retry: result.retry,
        status: result.status,
        startedAt: result.startTime.toISOString(),
        duration: Math.max(0, result.duration),
        workerIndex: result.workerIndex,
        errors: result.errors.map((item) => error(root, item)),
        steps: result.steps.map((item) => step(root, item)),
        attachments: result.attachments.flatMap((attachment) => {
          const artifactId = ids.get(attachment);
          return artifactId === undefined
            ? []
            : [
                {
                  name: attachment.name,
                  kind: kind(attachment),
                  mime: attachment.contentType,
                  artifactId,
                },
              ];
        }),
        ...(stdout === "" ? {} : { stdout }),
        ...(stderr === "" ? {} : { stderr }),
      };
    }),
  };
};
