import { artifactLinks, pulls, runs } from "@highalch/console-domain/Console.collections";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { ProjectId } from "@highalch/console-domain/Project/Project.id";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import type { RunRow } from "@highalch/console-domain/Run/Run.rows";
import * as HighAlch from "@lowalch/tanstack-db";
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState, type ReactNode } from "react";
import { Icon } from "../components/icons.tsx";
import { RunTests, type Test } from "../components/runTests.tsx";
import { Failed, FailedPanel, LoadingRows } from "../components/states.tsx";
import { CodeFrame, ErrorMessage } from "../components/test.tsx";
import { Button } from "../components/ui/button.tsx";
import { Mono } from "../components/ui/chip.tsx";
import { Empty, Panel, PanelHeader } from "../components/ui/panel.tsx";
import { Segmented } from "../components/ui/segmented.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { InlineStatus, StatusIcon, StatusPill } from "../components/ui/status.tsx";
import { elementsOf, testKey, type SnapshotEntry } from "../data/items.ts";
import { duration, shortSha } from "../lib/format.ts";
import { browserName, retriesLabel, testTitle, visibleSteps } from "../lib/tests.ts";
import { cn } from "../lib/cn.ts";

type Props = {
  readonly org: string;
  readonly project: string;
  readonly run: string;
  readonly test: string;
};

/**
 * Test detail (TestDetail board): the snapshot as Expected, Actual, Diff or a slider between
 * them; the error with its code frame; the last attempt's steps on a timeline; the test's
 * history across the pull request's runs, its attempts and its environment.
 */
export const TestScreen = (props: Props) => {
  const result = useLiveQuery((q) =>
    q.from({ run: runs.get({ run: RunId.make(props.run) }) }).findOne(),
  );
  return HighAlch.match(result).on({
    [HighAlch.anyOf("Loading", "Retrying")]: () => <Loading />,
    Missing: () => (
      <Panel>
        <Empty>Run {props.run} doesn't exist, or it was deleted.</Empty>
      </Panel>
    ),
    Ready: ({ data: row }) => (
      <RunTests run={props.run} fallback={<Loading />}>
        {(tests, snapshots) => {
          const test = tests.find((candidate) => candidate.id === props.test);
          return test === undefined ? (
            <Panel>
              <Empty>This run has no test {props.test}.</Empty>
            </Panel>
          ) : (
            <TestPage {...props} row={row} test={test} snapshot={snapshots} />
          );
        }}
      </RunTests>
    ),
    orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
  });
};

const Loading = () => (
  <Panel>
    <LoadingRows label="Loading the test" rows={4} />
  </Panel>
);

const TestPage = ({
  row,
  test,
  snapshot,
  ...props
}: Omit<Props, "test"> & {
  readonly row: RunRow;
  readonly test: Test;
  readonly snapshot: ReadonlyMap<string, SnapshotEntry>;
}) => {
  const attempt = test.attempts.at(-1);
  const error = attempt?.errors[0];
  const repro = `npx playwright test ${test.file}:${test.line} --project=${test.project}`;
  return (
    <>
      <section aria-labelledby="test-title" className="flex flex-col gap-3">
        <nav
          aria-label="Breadcrumb"
          className="flex flex-wrap items-center gap-2 text-label text-fg-muted"
        >
          <Link
            to="/$org/$project/runs/$run"
            params={{ org: props.org, project: props.project, run: props.run }}
            search={{ test: test.id }}
            className="inline-flex items-center gap-1 font-medium"
          >
            <Icon name="back" />
            Run {row.id}
          </Link>
          {row.pr === null ? null : (
            <>
              <span aria-hidden="true" className="text-fg-subtle">
                /
              </span>
              <span>Pull request #{row.pr}</span>
            </>
          )}
          <span aria-hidden="true" className="text-fg-subtle">
            /
          </span>
          <Mono className="min-w-0 truncate">{test.file}</Mono>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-1">
            <h1 id="test-title" className="m-0 text-title">
              {testTitle(test)}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-fg-muted">
              <StatusPill status={test.status} />
              <Mono className="whitespace-nowrap">
                {test.file}:{test.line}
              </Mono>
              <span className="whitespace-nowrap">{browserName(test)}</span>
              <span className="whitespace-nowrap">{retriesLabel(test.retries)}</span>
              <Mono className="whitespace-nowrap">{duration(test.duration)}</Mono>
            </div>
          </div>
          <Button onClick={() => void navigator.clipboard.writeText(repro)}>
            <Icon name="copy" />
            Copy repro command
          </Button>
        </div>
      </section>
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-4">
          {attempt === undefined ? null : (
            <SnapshotPanel run={props.run} test={test} attempt={attempt} snapshot={snapshot} />
          )}
          {error === undefined ? null : (
            <Panel aria-labelledby="err-title">
              <PanelHeader id="err-title" title="Error" />
              <div className="flex flex-col gap-3 p-4">
                <ErrorMessage message={error.message} />
                {error.snippet === undefined ? null : <CodeFrame snippet={error.snippet} />}
              </div>
            </Panel>
          )}
          {attempt === undefined ? null : <Steps attempt={attempt} />}
        </div>
        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-4">
          {row.pr === null ? null : <History {...props} row={row} test={test} />}
          <Attempts test={test} />
          <Environment test={test} />
        </aside>
      </div>
    </>
  );
};

// ---------------------------------------------------------------- snapshot

type Attempt = Test["attempts"][number];
type View = "expected" | "actual" | "diff" | "slider";

/**
 * The snapshot: the attempt's own expected/actual/diff images when Playwright wrote them
 * (`toHaveScreenshot`), else its screenshot against the baseline run's screenshot of the same
 * test (the run's snapshot map names it). Without a baseline only the actual image shows.
 */
const SnapshotPanel = ({
  run,
  test,
  attempt,
  snapshot,
}: {
  readonly run: string;
  readonly test: Test;
  readonly attempt: Attempt;
  readonly snapshot: ReadonlyMap<string, SnapshotEntry>;
}) => {
  const of = (kind: string) => attempt.attachments.find((attachment) => attachment.kind === kind);
  const actual = of("snapshot-actual") ?? of("screenshot");
  const expectedOwn = of("snapshot-expected");
  const diffOwn = of("snapshot-diff");
  const entry = actual === undefined ? undefined : snapshot.get(`${testKey(test)}|${actual.name}`);
  const baseline =
    expectedOwn === undefined &&
    entry?.baselineRunId !== undefined &&
    entry.baselineArtifactId !== undefined
      ? { run: entry.baselineRunId, id: entry.baselineArtifactId }
      : undefined;
  const [view, setView] = useState<View>("actual");
  if (actual === undefined) return null;
  const hasExpected = expectedOwn !== undefined || baseline !== undefined;
  const views: ReadonlyArray<{ readonly value: View; readonly label: string }> = hasExpected
    ? [
        { value: "expected", label: "Expected" },
        { value: "actual", label: "Actual" },
        { value: "diff", label: "Diff" },
        { value: "slider", label: "Slider" },
      ]
    : [{ value: "actual", label: "Actual" }];
  const shown = hasExpected ? view : "actual";
  const expected = expectedOwn === undefined ? baseline : { run, id: expectedOwn.artifactId };
  const caption =
    entry === undefined
      ? actual.name
      : entry.status === "unchanged"
        ? `${actual.name} · matches the baseline`
        : entry.status === "new"
          ? `${actual.name} · new, no baseline`
          : `${actual.name} · ${entry.status} since the baseline`;
  return (
    <Panel aria-labelledby="snap-title">
      <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg px-4 py-1">
        <h2 id="snap-title" className="m-0 text-body font-semibold">
          Snapshot
        </h2>
        <Segmented
          label="Snapshot view"
          size="sm"
          value={shown}
          onValueChange={setView}
          segments={views}
        />
        <Mono className="ml-auto min-w-0 truncate text-fg-muted">{caption}</Mono>
      </div>
      <div className="bg-subtle p-4">
        <div className="relative mx-auto max-w-[720px] overflow-hidden rounded-control border border-border bg-panel">
          <Images
            refs={[
              ...(expected === undefined ? [] : [expected]),
              { run, id: actual.artifactId },
              ...(diffOwn === undefined ? [] : [{ run, id: diffOwn.artifactId }]),
            ]}
          >
            {(urls) => {
              const expectedUrl = expected === undefined ? undefined : urls.get(expected.id);
              const actualUrl = urls.get(actual.artifactId);
              const diffUrl = diffOwn === undefined ? undefined : urls.get(diffOwn.artifactId);
              if (actualUrl === undefined) return <NoImage />;
              if (shown === "expected" && expectedUrl !== undefined)
                return <img src={expectedUrl} alt="Expected" className="block w-full" />;
              if (shown === "diff" && diffUrl !== undefined)
                return <img src={diffUrl} alt="Diff" className="block w-full" />;
              if (shown === "diff" && expectedUrl !== undefined)
                return (
                  // Differing pixels light up: the actual image over the expected with `difference`.
                  <div className="relative bg-black">
                    <img src={expectedUrl} alt="" className="block w-full" />
                    <img
                      src={actualUrl}
                      alt="Differences between expected and actual"
                      className="absolute inset-0 block w-full mix-blend-difference"
                    />
                  </div>
                );
              if (shown === "slider" && expectedUrl !== undefined)
                return <Slider expected={expectedUrl} actual={actualUrl} />;
              return <img src={actualUrl} alt="Actual" className="block w-full" />;
            }}
          </Images>
        </div>
      </div>
    </Panel>
  );
};

const NoImage = () => (
  <div className="grid aspect-video place-items-center text-label text-fg-muted">
    Not stored (yet), or removed by retention.
  </div>
);

/** Signed links for images of possibly different runs, grouped per run (one query each). */
const Images = ({
  refs,
  children,
}: {
  readonly refs: ReadonlyArray<{ readonly run: string; readonly id: string }>;
  readonly children: (urls: ReadonlyMap<string, string>) => ReactNode;
}) => {
  const runsOf = [...new Set(refs.map((ref) => ref.run))];
  const [first, second] = runsOf;
  const own = useLinks(
    first ?? "",
    refs.filter((ref) => ref.run === first).map((ref) => ref.id),
  );
  const other = useLinks(
    second ?? "",
    refs.filter((ref) => ref.run === second).map((ref) => ref.id),
  );
  if (own._tag === "Pending" || other._tag === "Pending")
    return (
      <div className="grid aspect-video place-items-center">
        <Skeleton className="w-32" />
      </div>
    );
  if (own._tag === "Failed") return <Failed error={own.error} retry={own.retry} />;
  if (other._tag === "Failed") return <Failed error={other.error} retry={other.retry} />;
  return children(new Map([...own.urls, ...other.urls]));
};

type Links =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Loaded"; readonly urls: ReadonlyMap<string, string> }
  | {
      readonly _tag: "Failed";
      readonly error: { readonly _tag: string };
      readonly retry: () => void;
    };

const useLinks = (run: string, ids: ReadonlyArray<string>): Links => {
  const result = useLiveQuery((q) =>
    run === "" || ids.length === 0
      ? undefined
      : q.from({ links: artifactLinks({ run: RunId.make(run), ids }) }),
  );
  return HighAlch.match(result).on({
    Loading: () => ({ _tag: "Pending" }) as const,
    Disabled: () => ({ _tag: "Loaded", urls: new Map() }) as const,
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) =>
      ({
        _tag: "Loaded",
        urls: new Map(
          data
            .flatMap((answer) => elementsOf(answer))
            .flatMap((entry) => (entry.link === null ? [] : [[entry.id, entry.link.url] as const])),
        ),
      }) as const,
    orElse: (error, { retry }) => ({ _tag: "Failed", error, retry }) as const,
  });
};

const Slider = ({ expected, actual }: { readonly expected: string; readonly actual: string }) => {
  const [at, setAt] = useState(50);
  return (
    <div className="relative">
      <img src={expected} alt="Expected" className="block w-full" />
      <img
        src={actual}
        alt="Actual"
        className="absolute inset-0 block w-full"
        style={{ clipPath: `inset(0 0 0 ${at}%)` }}
      />
      <span
        aria-hidden="true"
        className="absolute inset-y-0 w-0.5 bg-accent"
        style={{ left: `${at}%` }}
      />
      <input
        type="range"
        min={0}
        max={100}
        value={at}
        onChange={(event) => setAt(Number(event.target.value))}
        aria-label="Expected to actual"
        className="absolute inset-x-0 bottom-2 mx-auto w-1/2"
      />
    </div>
  );
};

// ---------------------------------------------------------------- steps, attempts, history

const Steps = ({ attempt }: { readonly attempt: Attempt }) => {
  const start = Date.parse(attempt.startedAt);
  const total = Math.max(1, attempt.duration);
  const steps = visibleSteps(attempt.steps);
  const columns = "grid grid-cols-[16px_minmax(0,2fr)_minmax(0,3fr)_80px] items-center gap-4 px-4";
  return (
    <Panel aria-labelledby="steps-title">
      <PanelHeader id="steps-title" title={`Steps, attempt ${attempt.retry + 1}`}>
        <Mono className="whitespace-nowrap text-fg-muted">0–{duration(attempt.duration)}</Mono>
      </PanelHeader>
      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
          <div
            className={cn(
              columns,
              "h-9 border-b border-border text-label font-medium text-fg-muted",
            )}
          >
            <span />
            <span>Step</span>
            <span>Timeline</span>
            <span className="text-right">Time</span>
          </div>
          <ol className="m-0 list-none p-0">
            {steps.map((step, index) => {
              const bad = step.error !== undefined;
              const left = Math.min(
                100,
                Math.max(0, ((Date.parse(step.startedAt) - start) / total) * 100),
              );
              const width = Math.max(1, Math.min(100 - left, (step.duration / total) * 100));
              return (
                <li
                  key={index}
                  className={cn(columns, "h-10 border-b border-border last:border-b-0")}
                >
                  <Icon
                    name={bad ? "cross" : "check"}
                    label={bad ? "Failed" : "Passed"}
                    className={bad ? "text-fail" : "text-pass"}
                  />
                  <span className="min-w-0 truncate font-mono text-label">{step.title}</span>
                  <span aria-hidden="true" className="relative h-2 rounded-full bg-subtle">
                    <span
                      className={cn(
                        "absolute inset-y-0 rounded-full",
                        bad ? "bg-fail-dot" : "bg-pass-dot",
                      )}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  </span>
                  <span
                    className={cn(
                      "whitespace-nowrap text-right font-mono text-label",
                      bad ? "text-fail" : "text-fg-muted",
                    )}
                  >
                    {duration(step.duration)}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </Panel>
  );
};

const Attempts = ({ test }: { readonly test: Test }) => {
  const columns = "grid grid-cols-[64px_minmax(0,1fr)_72px] items-center gap-2 px-4";
  return (
    <Panel aria-labelledby="retry-title">
      <PanelHeader id="retry-title" title="Attempts" />
      <div role="table" aria-label="Attempts">
        <div
          role="row"
          className={cn(columns, "h-9 border-b border-border text-label font-medium text-fg-muted")}
        >
          <span role="columnheader">Attempt</span>
          <span role="columnheader">Result</span>
          <span role="columnheader" className="text-right">
            Time
          </span>
        </div>
        {test.attempts.map((attempt) => (
          <div
            key={attempt.retry}
            role="row"
            className={cn(columns, "h-9 border-b border-border text-label last:border-b-0")}
          >
            <span role="cell" className="font-mono text-caption">
              {attempt.retry + 1}
            </span>
            <span role="cell">
              <InlineStatus
                status={
                  attempt.status === "passed"
                    ? "passed"
                    : attempt.status === "skipped"
                      ? "skipped"
                      : "failed"
                }
              >
                {attempt.status === "timedOut"
                  ? "Timed out"
                  : attempt.status[0]?.toUpperCase() + attempt.status.slice(1)}
              </InlineStatus>
            </span>
            <span role="cell" className="whitespace-nowrap text-right font-mono text-caption">
              {duration(attempt.duration)}
            </span>
          </div>
        ))}
      </div>
      <p className="m-0 border-t border-border px-4 py-3 text-label text-fg-muted">
        {test.status === "flaky"
          ? "It failed, then passed on a retry: likely flaky, not a regression."
          : test.attempts.length > 1 && test.status === "failed"
            ? "It failed on every attempt: likely a real regression, not flakiness."
            : test.status === "passed"
              ? "It passed on the first attempt."
              : "It did not run."}
      </p>
    </Panel>
  );
};

const Environment = ({ test }: { readonly test: Test }) => (
  <Panel aria-labelledby="env-title">
    <PanelHeader id="env-title" title="Environment" />
    <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-1 px-4 py-3 text-label">
      <dt className="text-fg-muted">Project</dt>
      <dd className="m-0 font-mono text-caption">{test.project}</dd>
      <dt className="text-fg-muted">Browser</dt>
      <dd className="m-0">{browserName(test)}</dd>
      <dt className="text-fg-muted">Worker</dt>
      <dd className="m-0 font-mono text-caption">{test.attempts.at(-1)?.workerIndex ?? "—"}</dd>
      <dt className="text-fg-muted">Tags</dt>
      <dd className="m-0 font-mono text-caption">
        {test.tags.length === 0 ? "—" : test.tags.join(" ")}
      </dd>
    </dl>
  </Panel>
);

/** The test on every commit of the pull request that had a Playwright run, oldest first. */
const History = ({
  org,
  project,
  row,
  test,
}: Omit<Props, "test"> & { readonly row: RunRow; readonly test: Test }) => {
  const onPull = useLiveQuery((q) =>
    q.from({
      run: runs.list({
        org: OrganizationId.make(org),
        project: ProjectId.make(project),
        pr: row.pr ?? 0,
      }),
    }),
  );
  const pullRows = useLiveQuery((q) =>
    q.from({ pull: pulls.list({ project: ProjectId.make(project) }) }),
  );
  const order: ReadonlyArray<string> = HighAlch.match(pullRows).on({
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) =>
      data.find((pull) => pull.number === row.pr)?.commits ?? [],
    orElse: () => [],
  });
  return (
    <Panel aria-labelledby="hist-title">
      <PanelHeader id="hist-title" title="History in this pull request" />
      {HighAlch.match(onPull).on({
        [HighAlch.anyOf("Loading", "Retrying")]: () => (
          <LoadingRows label="Loading history" rows={3} />
        ),
        Ready: ({ data }) => {
          const ordered = data
            .filter((candidate) => candidate.kind === "playwright")
            .sort(
              (a, b) =>
                order.indexOf(a.commit) - order.indexOf(b.commit) || a.createdAt - b.createdAt,
            );
          return (
            <ol className="m-0 list-none p-0">
              {ordered.map((candidate) => (
                <li
                  key={candidate.id}
                  className={cn(
                    "grid h-9 grid-cols-[16px_64px_minmax(0,1fr)_88px] items-center gap-2 border-b border-border px-4 last:border-b-0",
                    candidate.id === row.id ? "bg-accent-subtle shadow-selected" : "",
                  )}
                >
                  <RunTests run={candidate.id} fallback={<Skeleton className="size-4" />}>
                    {(tests) => {
                      const same = tests.find((other) => other.id === test.id);
                      return same === undefined ? (
                        <span className="size-4" />
                      ) : (
                        <StatusIcon status={same.status} />
                      );
                    }}
                  </RunTests>
                  <Link
                    to="/$org/$project/runs/$run/tests/$test"
                    params={{ org, project, run: candidate.id, test: test.id }}
                    className="font-mono text-caption leading-5 font-medium"
                  >
                    {shortSha(candidate.commit)}
                  </Link>
                  <span className="min-w-0 truncate text-label text-fg-muted">
                    {candidate.commitInfo?.message ?? ""}
                  </span>
                  <span className="whitespace-nowrap text-right text-caption text-fg-subtle">
                    {candidate.id === row.id ? "This run" : `Run ${candidate.id}`}
                  </span>
                </li>
              ))}
            </ol>
          );
        },
        orElse: (error, { retry }) => <Failed error={error} retry={retry} />,
      })}
    </Panel>
  );
};
