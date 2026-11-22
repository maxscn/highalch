import type { CommitInfo, PullInfo } from "@highalch/console-domain/Run/Run.values";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Environment variables. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Commit, branch, PR and source of the current run. */
export interface Context {
  readonly commit: string;
  readonly branch: string;
  readonly pr: number | undefined;
  /** Where the run came from: `github-actions`, `gitlab-ci`, `circleci`, `buildkite`, `ci`, `local`. */
  readonly source: string;
  /** The branch a pull/merge request targets (its snapshot baseline). */
  readonly baseBranch?: string;
  /** Commit message, author and time from `git log` (display only). */
  readonly commitInfo?: CommitInfo;
  /** Pull request title, author, base and state from the GitHub event (display only). */
  readonly pull?: PullInfo;
}

/** Fallback when no commit can be detected (outside CI and outside a git checkout). */
export const unknownCommit = "0000000000000000000000000000000000000000";

const number = (value: string | undefined): number | undefined => {
  const found = value === undefined ? null : /(\d+)\/?$/.exec(value);
  if (!found?.[1]) return undefined;
  const parsed = Number(found[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const filled = (...values: ReadonlyArray<string | undefined>) =>
  values.find((value) => value !== undefined && value !== "");

const Event = Schema.fromJsonString(
  Schema.Struct({
    pull_request: Schema.optionalKey(
      Schema.Struct({
        number: Schema.optionalKey(Schema.Number),
        title: Schema.optionalKey(Schema.String),
        state: Schema.optionalKey(Schema.String),
        merged: Schema.optionalKey(Schema.Boolean),
        user: Schema.optionalKey(Schema.Struct({ login: Schema.String })),
        head: Schema.optionalKey(Schema.Struct({ sha: Schema.optionalKey(Schema.String) })),
        base: Schema.optionalKey(Schema.Struct({ ref: Schema.String, sha: Schema.String })),
      }),
    ),
  }),
);

/** The GitHub event payload; an unreadable or foreign file reads as empty. */
const event = (path: string | undefined) =>
  path === undefined
    ? Effect.succeed({})
    : Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Event)),
        Effect.orElseSucceed(() => ({})),
      );

/** `git <args>` in `cwd`; no git or no checkout reads as none. */
const git = (args: ReadonlyArray<string>, cwd: string) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.string(ChildProcess.make("git", [...args], { cwd })),
  ).pipe(
    Effect.map((out) => Option.liftPredicate(out.trim(), (s) => s !== "")),
    Effect.timeoutOption("5 seconds"),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/** `git log -1` of the checkout: message, author and commit time (absent outside a checkout). */
const commitInfo = (cwd: string) =>
  Effect.map(git(["log", "-1", "--format=%an%x1f%ae%x1f%cI%x1f%B"], cwd), (out) =>
    Option.flatMap(out, (text): Option.Option<CommitInfo> => {
      const [name, email, at, ...message] = text.split("\x1f");
      return name && email && at && /^\d{4}-/.test(at)
        ? Option.some({
            message: message.join("\x1f").trim().slice(0, 10_000),
            author: { login: email.split("@")[0] ?? name, name },
            committedAt: new Date(at).toISOString(),
          })
        : Option.none();
    }),
  );

/**
 * Detects the run context from CI variables. GitHub Actions reads the event payload so a
 * pull_request run reports the PR head commit (not the synthetic merge commit) and PR number.
 * Outside CI it falls back to `git` in `cwd`, then to {@link unknownCommit} / `"unknown"`.
 */
export const detect = Effect.fn("Ci.detect")(function* (env: Env, cwd: string) {
  if (env.GITHUB_ACTIONS === "true") {
    const payload: Schema.Schema.Type<typeof Event> = yield* event(env.GITHUB_EVENT_PATH);
    const baseBranch = filled(env.GITHUB_BASE_REF);
    const pr = payload.pull_request;
    const info = yield* commitInfo(cwd);
    return {
      commit: filled(payload.pull_request?.head?.sha, env.GITHUB_SHA) ?? unknownCommit,
      branch: filled(env.GITHUB_HEAD_REF, env.GITHUB_REF_NAME) ?? "unknown",
      pr:
        payload.pull_request?.number ??
        (/^refs\/pull\/\d+\//.test(env.GITHUB_REF ?? "")
          ? number(env.GITHUB_REF?.split("/")[2])
          : undefined),
      source: "github-actions",
      ...(baseBranch ? { baseBranch } : {}),
      ...(Option.isSome(info) ? { commitInfo: info.value } : {}),
      ...(pr?.title !== undefined && pr.user && pr.base
        ? {
            pull: {
              title: pr.title.slice(0, 500),
              author: { login: pr.user.login, name: pr.user.login },
              base: pr.base.ref,
              baseSha: pr.base.sha,
              state: pr.merged
                ? ("merged" as const)
                : pr.state === "closed"
                  ? ("closed" as const)
                  : ("open" as const),
            },
          }
        : {}),
    } satisfies Context;
  }
  if (env.GITLAB_CI === "true") {
    const baseBranch = filled(env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME);
    return {
      commit: filled(env.CI_COMMIT_SHA) ?? unknownCommit,
      branch: filled(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME, env.CI_COMMIT_REF_NAME) ?? "unknown",
      pr: number(env.CI_MERGE_REQUEST_IID),
      source: "gitlab-ci",
      ...(baseBranch ? { baseBranch } : {}),
    } satisfies Context;
  }
  if (env.CIRCLECI === "true")
    return {
      commit: filled(env.CIRCLE_SHA1) ?? unknownCommit,
      branch: filled(env.CIRCLE_BRANCH) ?? "unknown",
      pr: number(env.CIRCLE_PULL_REQUEST),
      source: "circleci",
    } satisfies Context;
  if (env.BUILDKITE === "true") {
    const baseBranch = filled(env.BUILDKITE_PULL_REQUEST_BASE_BRANCH);
    return {
      commit: filled(env.BUILDKITE_COMMIT) ?? unknownCommit,
      branch: filled(env.BUILDKITE_BRANCH) ?? "unknown",
      pr: number(env.BUILDKITE_PULL_REQUEST),
      source: "buildkite",
      ...(baseBranch ? { baseBranch } : {}),
    } satisfies Context;
  }
  const ci = env.CI !== undefined && env.CI !== "" && env.CI !== "false" && env.CI !== "0";
  return {
    commit: Option.getOrElse(yield* git(["rev-parse", "HEAD"], cwd), () => unknownCommit),
    branch: Option.getOrElse(
      yield* git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
      () => "unknown",
    ),
    pr: undefined,
    source: ci ? "ci" : "local",
  } satisfies Context;
});
