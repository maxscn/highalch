import {
  open,
  type Failure,
  type File,
  type LocalReason,
  type Options,
} from "@highalch/console-client";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import * as Convert from "./convert.ts";

export interface ConsoleReporterOptions extends Options {
  /** Fail the Playwright run (exit non-zero) when reporting fails. Default false. */
  readonly strict?: boolean;
  /** Receives one-line status and failure messages (never credentials). Default `console.warn`. */
  readonly log?: (message: string) => void;
}

export type Reported =
  | { readonly status: "uploaded"; readonly runId: string; readonly org: string }
  | {
      readonly status: "written";
      readonly runId: string;
      readonly dir: string;
      readonly reason: LocalReason;
    }
  | { readonly status: "failed"; readonly error: Failure };

/**
 * Playwright reporter that uploads the run to HighAlch Console (or writes it to `.highalch/`
 * without a URL or credential). Use in `playwright.config.ts`:
 * `reporter: [["list"], ["@highalch/console-playwright"]]` with `HIGHALCH_URL` and
 * `HIGHALCH_API_KEY` (or GitHub Actions OIDC) set.
 */
export class ConsoleReporter implements Reporter {
  private root = process.cwd();
  private readonly results = new Map<string, { test: TestCase; results: Array<TestResult> }>();
  private readonly log: (message: string) => void;
  /** Outcome of the last `onEnd`, for programmatic callers and tests. */
  reported: Reported | undefined;

  constructor(private readonly options: ConsoleReporterOptions = {}) {
    this.log = options.log ?? ((message: string) => console.warn(message));
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    this.root = config.rootDir;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const entry = this.results.get(test.id) ?? { test, results: [] };
    entry.results.push(result);
    this.results.set(test.id, entry);
  }

  /** Playwright's callback: the Promise facade over {@link ConsoleReporter.report}. */
  onEnd(_result: FullResult): Promise<{ status?: FullResult["status"] } | undefined> {
    return Effect.runPromise(
      this.report().pipe(
        Effect.map((reported) => {
          this.reported = reported;
          if (reported.status === "written")
            this.log(`[highalch] wrote ${this.results.size} tests to ${reported.dir}`);
          return undefined;
        }),
        Effect.catch((error: Failure) => {
          this.reported = { status: "failed", error };
          this.log(`[highalch] results not reported (${error._tag})`);
          return Effect.succeed(this.options.strict ? { status: "failed" as const } : undefined);
        }),
        Effect.provide(NodeServices.layer),
      ),
    );
  }

  /** Uploads the collected run (or writes it to `.highalch/`): the Effect core. */
  report() {
    const { options, root } = this;
    const collected = this.results;
    const log = this.log;
    return Effect.gen(function* () {
      const upload = yield* open(options, "playwright");
      const fs = yield* FileSystem.FileSystem;
      const files: Array<File> = [];
      const owners: Array<Convert.Attachment> = [];
      for (const { results } of collected.values())
        for (const attempt of results)
          for (const attachment of attempt.attachments) {
            const body =
              attachment.body !== undefined
                ? Option.some(
                    new Uint8Array(
                      attachment.body.buffer,
                      attachment.body.byteOffset,
                      attachment.body.byteLength,
                    ),
                  )
                : attachment.path
                  ? yield* fs.readFile(attachment.path).pipe(
                      Effect.map(Option.some),
                      Effect.catch(() =>
                        Effect.sync(() => {
                          log(`[highalch] skipped unreadable attachment "${attachment.name}"`);
                          return Option.none<Uint8Array>();
                        }),
                      ),
                    )
                  : Option.none<Uint8Array>();
            if (Option.isNone(body)) continue;
            files.push({ name: attachment.name, mime: attachment.contentType, body: body.value });
            owners.push(attachment);
          }
      const artifactIds = yield* upload.artifacts(files);
      const ids = new Map(
        owners.map((attachment, index) => [attachment, artifactIds[index] ?? ""]),
      );
      const tests = [...collected.values()].map(({ test, results }) =>
        Convert.test(root, test, results, ids),
      );
      yield* upload.results({ tests });
      const outcome = yield* upload.complete();
      return outcome.mode === "remote"
        ? ({ status: "uploaded", runId: outcome.runId, org: outcome.org } satisfies Reported)
        : ({
            status: "written",
            runId: outcome.runId,
            dir: outcome.dir,
            reason: outcome.reason,
          } satisfies Reported);
    }).pipe(Effect.scoped);
  }
}

export default ConsoleReporter;
