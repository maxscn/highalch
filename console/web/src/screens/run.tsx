import { projects, pulls, runs } from "@highalch/console-domain/Console.collections";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { ProjectId } from "@highalch/console-domain/Project/Project.id";
import type { PullRow } from "@highalch/console-domain/Project/Source.rows";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import type { RunRow } from "@highalch/console-domain/Run/Run.rows";
import * as HighAlch from "@lowalch/tanstack-db";
import { Link, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import type { ReactNode } from "react";
import { BranchInto, Icon } from "../components/icons.tsx";
import { PageHeader, Sep } from "../components/page.tsx";
import { FailedPanel, LoadingRows, Reconnecting } from "../components/states.tsx";
import { Attachments, CodeFrame, ErrorMessage, StepList } from "../components/test.tsx";
import { buttonVariants } from "../components/ui/button.tsx";
import { Mono } from "../components/ui/chip.tsx";
import { SearchInput } from "../components/ui/input.tsx";
import {
  Empty,
  Panel,
  PanelHeader,
  PanelSection,
  SectionHeading,
} from "../components/ui/panel.tsx";
import { Segmented } from "../components/ui/segmented.tsx";
import {
  Dot,
  Slot,
  StatusIcon,
  StatusPill,
  statusText,
  type Status,
} from "../components/ui/status.tsx";
import { NumberCell, rowClass, Table, TableGroup, TableHeader } from "../components/ui/table.tsx";
import { testKey, type SnapshotEntry } from "../data/items.ts";
import { RunTests, type Test } from "../components/runTests.tsx";
import { age, ago, count, duration, percent, shortSha } from "../lib/format.ts";
import { useNow } from "../lib/now.tsx";
import { runResult, runStatus, waitingFor } from "../lib/outcome.ts";
import { browserName, retriesLabel, testTitle } from "../lib/tests.ts";
import { cn } from "../lib/cn.ts";
import { commitsOf, kindLabel } from "./runs.tsx";

/** What the run page keeps in its URL: the selected test, the results filter and search. */
export type RunSearch = {
  readonly test?: string | undefined;
  readonly status?: "failed" | "flaky" | "passed" | "changed" | undefined;
  readonly q?: string | undefined;
};

type Props = {
  readonly org: string;
  readonly project: string;
  readonly run: string;
  readonly search: RunSearch;
  readonly onSearch: (next: RunSearch) => void;
};

/**
 * Run overview (Main board): the pull request and commit it ran on, a summary against its
 * baseline, the pull request's commits as a timeline, its Playwright results grouped by spec
 * file with a detail pane, and fuzzing on the same commit.
 */
export const RunScreen = (props: Props) => {
  const result = useLiveQuery((q) =>
    q.from({ run: runs.get({ run: RunId.make(props.run) }) }).findOne(),
  );
  return HighAlch.match(result).on({
    Loading: () => (
      <Panel>
        <LoadingRows label="Loading the run" rows={4} />
      </Panel>
    ),
    Retrying: ({ data }) => (
      <>
        <Reconnecting />
        <RunPage {...props} row={data} />
      </>
    ),
    Ready: ({ data }) => <RunPage {...props} row={data} />,
    Missing: () => (
      <Panel>
        <Empty>Run {props.run} doesn't exist, or it was deleted.</Empty>
      </Panel>
    ),
    orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
  });
};

const usePull = (project: string, number: number | null): PullRow | undefined => {
  const result = useLiveQuery((q) =>
    q.from({ pull: pulls.list({ project: ProjectId.make(project) }) }),
  );
  return HighAlch.match(result).on({
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) =>
      data.find((pull) => pull.number === number),
    orElse: () => undefined,
  });
};

const useRepository = (org: string, project: string): string | null => {
  const result = useLiveQuery((q) =>
    q.from({ project: projects.list({ org: OrganizationId.make(org) }) }),
  );
  return HighAlch.match(result).on({
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) =>
      data.find((row) => row.slug === project)?.repository ?? null,
    orElse: () => null,
  });
};

const RunPage = ({ row, ...props }: Props & { readonly row: RunRow }) => {
  const now = useNow();
  const pull = usePull(props.project, row.pr);
  const repository = useRepository(props.org, props.project);
  const commit = row.commitInfo;
  const status = runStatus(row);
  const github =
    repository === null
      ? null
      : row.pr === null
        ? `https://github.com/${repository}/commit/${row.commit}`
        : `https://github.com/${repository}/pull/${row.pr}`;
  return (
    <>
      <PageHeader
        id="run-title"
        above={
          <>
            {row.pr === null ? (
              <span>{row.branch}</span>
            ) : (
              <Link
                to="/$org/$project/pulls/$pull"
                params={{ org: props.org, project: props.project, pull: String(row.pr) }}
              >
                Pull request #{row.pr}
              </Link>
            )}
            <Sep />
            <span>
              Run <Mono>{row.id}</Mono>
            </span>
            <Sep />
            <span>{kindLabel[row.kind]}</span>
          </>
        }
        title={pull?.title ?? commit?.message ?? `Run ${row.id}`}
        meta={
          <>
            <BranchInto branch={row.branch} base={row.pr === null ? null : row.baseBranch} />
            <Mono className="whitespace-nowrap text-accent">{shortSha(row.commit)}</Mono>
            {commit === null ? null : (
              <span className="whitespace-nowrap">{commit.author.name}</span>
            )}
            <span className="whitespace-nowrap">
              {row.source === "github-actions" ? "GitHub Actions" : row.source}
            </span>
            {row.completedAt === null ? null : (
              <Mono className="whitespace-nowrap">{duration(row.completedAt - row.createdAt)}</Mono>
            )}
            <span className="whitespace-nowrap">{ago(row.createdAt, now)}</span>
          </>
        }
        actions={
          <>
            <StatusPill status={status} />
            {github === null ? null : (
              <a href={github} className={buttonVariants({ variant: "secondary" })}>
                View on GitHub
                <Icon name="external" />
              </a>
            )}
          </>
        }
      />
      {row.kind === "fuzz" ? (
        <FuzzSummary row={row} />
      ) : row.kind === "stories" ? (
        <StorySummary row={row} />
      ) : (
        <Summary row={row} />
      )}
      {waitingFor(row) === null ? null : (
        <p role="status" className="m-0 flex items-center gap-2 text-label text-running">
          <Icon name="running" />
          CI asked to complete this run; it is waiting for {waitingFor(row)} more{" "}
          {waitingFor(row) === 1 ? "upload" : "uploads"} it accepted to arrive.
        </p>
      )}
      {row.truncated === 0 ? null : (
        <p role="note" className="m-0 flex items-center gap-2 text-label text-flaky">
          <Icon name="alert" />
          {count(row.truncated)} result items of this run went beyond its plan's allowance: they are
          not compared and not shown.
        </p>
      )}
      {row.pr === null || pull === undefined ? null : <Timeline {...props} row={row} pull={pull} />}
      {row.kind === "stories" ? (
        <StoriesLink {...props} row={row} />
      ) : row.kind === "playwright" ? (
        <Results {...props} />
      ) : (
        <Panel>
          <PanelHeader title="Fuzzing results" />
          <p className="m-0 p-4 text-body text-fg-muted">
            The fuzzing screens come in a later round. This run's counts are above.
          </p>
        </Panel>
      )}
      {row.kind === "playwright" ? <FuzzOnCommit {...props} row={row} /> : null}
    </>
  );
};

// ---------------------------------------------------------------- summary

const Tile = ({
  label,
  status,
  value,
  note,
  tone,
  last,
}: {
  readonly label: string;
  readonly status?: Status;
  readonly value: ReactNode;
  readonly note: ReactNode;
  readonly tone?: string;
  readonly last?: boolean;
}) => (
  <div
    className={cn(
      // Two columns on a phone (hairlines between them), one row of six from `sm` up.
      "flex min-w-0 flex-col gap-1 border-border p-4 max-sm:border-b max-sm:odd:border-r max-sm:[&:nth-last-child(-n+2)]:border-b-0 sm:border-l sm:first:border-l-0",
      last && "bg-bg",
    )}
  >
    <dt className="flex items-center gap-1 text-label font-medium text-fg-muted">
      {status === undefined ? <Slot /> : <Dot status={status} />}
      {label}
    </dt>
    <dd className={cn("m-0 whitespace-nowrap text-title", tone)}>{value}</dd>
    <dd className={cn("m-0 text-label text-fg-subtle", tone)}>{note}</dd>
  </div>
);

const useBaseline = (baseline: string | null) => {
  const result = useLiveQuery((q) =>
    baseline === null
      ? undefined
      : q.from({ run: runs.get({ run: RunId.make(baseline) }) }).findOne(),
  );
  return HighAlch.match(result).on({
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) => data,
    orElse: () => undefined,
  });
};

const difference = (now: number, before: number | undefined, noun: string, base: string) => {
  if (before === undefined) return null;
  const delta = now - before;
  if (delta === 0) return `same as ${base}`;
  return `${Math.abs(delta)} ${delta > 0 ? "more" : "fewer"} ${noun} than ${base}`;
};

const Summary = ({ row }: { readonly row: RunRow }) => {
  const baseline = useBaseline(row.baseline);
  const { passed, failed, flaky, skipped } = row.summary.tests;
  const total = passed + failed + flaky + skipped;
  const base = row.baseBranch;
  const took = row.completedAt === null ? null : row.completedAt - row.createdAt;
  const baseTook = baseline?.completedAt == null ? null : baseline.completedAt - baseline.createdAt;
  const failedBefore = baseline?.summary.tests.failed;
  const delta = failedBefore === undefined ? null : failed - failedBefore;
  return (
    <Panel aria-label="Run summary">
      <div className="overflow-x-auto">
        <dl className="m-0 grid grid-cols-2 sm:min-w-[768px] sm:grid-cols-[repeat(6,minmax(128px,1fr))]">
          <Tile
            label="Passed"
            status="passed"
            value={count(passed)}
            note={`of ${count(total)} tests`}
          />
          <Tile
            label="Failed"
            status="failed"
            value={count(failed)}
            note={
              difference(failed, failedBefore, "", base)?.replace("  ", " ") ?? "no baseline yet"
            }
            {...(delta !== null && delta > 0 ? { tone: "text-fail" } : {})}
          />
          <Tile label="Flaky" status="flaky" value={count(flaky)} note="passed on retry" />
          <Tile label="Skipped" status="skipped" value={count(skipped)} note="skip or fixme" />
          <Tile
            label="Duration"
            value={took === null ? "—" : duration(took)}
            note={
              took === null || baseTook === null
                ? " "
                : took === baseTook
                  ? `same as ${base}`
                  : `${duration(Math.abs(took - baseTook))} ${took > baseTook ? "slower" : "faster"} than ${base}`
            }
          />
          <Tile
            label={`Compared with ${base}`}
            value={
              delta === null
                ? "—"
                : delta === 0
                  ? "No change"
                  : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} failing`
            }
            note={
              baseline === undefined ? (
                "no earlier run to compare"
              ) : (
                <>
                  {base} at <Mono>{shortSha(baseline.commit)}</Mono> had{" "}
                  {baseline.summary.tests.failed}
                </>
              )
            }
            {...(delta !== null && delta > 0 ? { tone: "text-fail" } : {})}
            last
          />
        </dl>
      </div>
      <div className="flex items-center gap-4 border-t border-border px-4 py-3">
        <div
          role="img"
          aria-label={`${passed} passed, ${failed} failed, ${flaky} flaky, ${skipped} skipped`}
          className="flex h-2 min-w-0 flex-1 gap-1"
        >
          {passed > 0 ? (
            <span className="rounded-full bg-pass-dot" style={{ flex: passed }} />
          ) : null}
          {failed > 0 ? (
            <span className="min-w-2 rounded-full bg-fail-dot" style={{ flex: failed }} />
          ) : null}
          {flaky > 0 ? (
            <span className="min-w-2 rounded-full bg-flaky-dot" style={{ flex: flaky }} />
          ) : null}
          {skipped > 0 ? (
            <span className="rounded-full bg-skipped-dot" style={{ flex: skipped }} />
          ) : null}
        </div>
        <Mono className="whitespace-nowrap text-fg-muted">
          {percent(passed + flaky, total - skipped)} pass
        </Mono>
      </div>
      {row.summary.stories.passed + row.summary.stories.failed === 0 ? null : (
        <div className="flex items-center gap-2 border-t border-border px-4 py-3 text-label text-fg-muted">
          <Dot status={row.summary.stories.failed > 0 ? "failed" : "passed"} />
          Stories: {row.summary.stories.passed} passed, {row.summary.stories.failed} failed
        </div>
      )}
    </Panel>
  );
};

const FuzzSummary = ({ row }: { readonly row: RunRow }) => {
  const { ok, overflow, crash, a11y } = row.summary.cases;
  const { passed, failed } = row.summary.traces;
  return (
    <Panel aria-label="Run summary">
      <div className="overflow-x-auto">
        <dl className="m-0 grid grid-cols-2 sm:min-w-[768px] sm:grid-cols-[repeat(6,minmax(128px,1fr))]">
          <Tile label="Cases" value={count(ok + overflow + crash + a11y)} note="generated" />
          <Tile label="OK" status="passed" value={count(ok)} note="rendered as expected" />
          <Tile label="Overflow" status="flaky" value={count(overflow)} note="content overflowed" />
          <Tile label="A11y" status="running" value={count(a11y)} note="accessibility findings" />
          <Tile
            label="Crash"
            status="failed"
            value={count(crash)}
            note="threw while rendering"
            {...(crash > 0 ? { tone: "text-fail" } : {})}
          />
          <Tile
            label="Traces"
            value={`${count(passed)} / ${count(passed + failed)}`}
            note={`${count(failed)} failed`}
            last
          />
        </dl>
      </div>
    </Panel>
  );
};

const StorySummary = ({ row }: { readonly row: RunRow }) => {
  const { passed, failed, frames } = row.summary.stories;
  const differ = frames.mismatch + frames.missing;
  return (
    <Panel aria-label="Run summary">
      <div className="overflow-x-auto">
        <dl className="m-0 grid grid-cols-2 sm:min-w-[768px] sm:grid-cols-[repeat(6,minmax(128px,1fr))]">
          <Tile label="Stories" value={count(passed + failed)} note="each slug's latest report" />
          <Tile label="Passed" status="passed" value={count(passed)} note="every step passed" />
          <Tile
            label="Failed"
            status="failed"
            value={count(failed)}
            note="a step or invariant failed"
            {...(failed > 0 ? { tone: "text-fail" } : {})}
          />
          <Tile
            label="Frames"
            value={count(frames.matched + frames.created + frames.updated + differ)}
            note={`${count(frames.matched)} match their baselines`}
          />
          <Tile
            label="New frames"
            status="running"
            value={count(frames.created + frames.updated)}
            note="new or updated baselines"
          />
          <Tile
            label="Differ"
            status="failed"
            value={count(differ)}
            note="from their baselines"
            {...(differ > 0 ? { tone: "text-fail" } : {})}
            last
          />
        </dl>
      </div>
    </Panel>
  );
};

// ---------------------------------------------------------------- timeline

const Timeline = ({
  org,
  project,
  row,
  pull,
}: Props & { readonly row: RunRow; readonly pull: PullRow }) => {
  const now = useNow();
  const navigate = useNavigate();
  const result = useLiveQuery((q) =>
    q.from({
      run: runs.list({
        org: OrganizationId.make(org),
        project: ProjectId.make(project),
        pr: row.pr ?? 0,
      }),
    }),
  );
  const onPull = HighAlch.match(result).on({
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) => data,
    orElse: () => [],
  });
  const messages = commitsOf(onPull);
  const runOf = (sha: string) =>
    onPull
      .filter((candidate) => candidate.commit === sha && candidate.kind === row.kind)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  const at = (sha: string) => Date.parse(messages.get(sha)?.committedAt ?? "") || 0;
  const ordered = [...pull.commits].sort((a, b) => at(a) - at(b));
  const firstFailing = ordered.find((sha) => {
    const found = runOf(sha);
    return found !== undefined && runStatus(found) === "failed";
  });
  return (
    <section aria-labelledby="commits-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 id="commits-title" className="m-0 text-subheading">
          Commits in this pull request
        </h2>
        {firstFailing === undefined ? null : (
          <span className="text-label text-fg-muted">
            First failure introduced in{" "}
            <Mono className="text-accent">{shortSha(firstFailing)}</Mono>
          </span>
        )}
      </div>
      <div className="overflow-x-auto rounded-panel border border-border bg-panel">
        <ol
          className="m-0 grid list-none p-0"
          style={{
            gridTemplateColumns: `repeat(${ordered.length}, minmax(160px, 1fr))`,
            minWidth: ordered.length * 160,
          }}
        >
          {ordered.map((sha) => {
            const found = runOf(sha);
            const status = found === undefined ? undefined : runStatus(found);
            const selected = sha === row.commit;
            const commit = messages.get(sha);
            return (
              <li key={sha} className="flex min-w-0 border-l border-border first:border-l-0">
                <button
                  type="button"
                  aria-pressed={selected}
                  disabled={found === undefined}
                  onClick={() =>
                    found === undefined
                      ? undefined
                      : void navigate({
                          to: "/$org/$project/runs/$run",
                          params: { org, project, run: found.id },
                        })
                  }
                  className={cn(
                    "flex min-w-0 flex-1 cursor-pointer flex-col gap-1 border-0 px-4 py-3 text-left disabled:cursor-default",
                    selected
                      ? "bg-accent-subtle shadow-[inset_0_-2px_0_var(--accent)]"
                      : "bg-panel hover:bg-bg",
                  )}
                >
                  <span className="flex w-full items-center gap-1">
                    {status === undefined ? <Slot /> : <Dot status={status} />}
                    <span className="font-mono text-caption leading-5 font-medium text-fg">
                      {shortSha(sha)}
                    </span>
                    {commit === undefined ? null : (
                      <span className="ml-auto whitespace-nowrap text-caption text-fg-subtle">
                        {age(Date.parse(commit.committedAt), now)}
                      </span>
                    )}
                  </span>
                  <span className="w-full truncate text-label text-fg">
                    {commit?.message ?? "—"}
                  </span>
                  <span
                    className={cn(
                      "whitespace-nowrap text-caption",
                      status === undefined ? "text-fg-subtle" : statusText(status),
                    )}
                  >
                    {found === undefined ? "No run" : runResult(found)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------- results

const Results = (props: Props) => (
  <section aria-labelledby="results-title" className="flex flex-col gap-3">
    <RunTests run={props.run} fallback={<ResultsLoading />}>
      {(tests, changes) => <TestResults {...props} tests={tests} changes={changes} />}
    </RunTests>
  </section>
);

const ResultsLoading = () => (
  <>
    <SectionHeading id="results-title" title="Playwright results" />
    <Panel>
      <LoadingRows label="Loading results" rows={5} />
    </Panel>
  </>
);

const order: Record<Status, number> = { failed: 0, flaky: 1, running: 2, passed: 3, skipped: 4 };

const isChanged = (changes: ReadonlyMap<string, SnapshotEntry>, test: Test) => {
  const entry = changes.get(testKey(test));
  return entry !== undefined && entry.status !== "unchanged";
};

const TestResults = ({
  tests,
  changes,
  search,
  onSearch,
  ...props
}: Props & {
  readonly tests: ReadonlyArray<Test>;
  readonly changes: ReadonlyMap<string, SnapshotEntry>;
}) => {
  const text = search.q?.trim().toLowerCase() ?? "";
  const matchesStatus = (test: Test) =>
    search.status === undefined ||
    (search.status === "changed" ? isChanged(changes, test) : test.status === search.status);
  const shown = tests
    .filter(
      (test) =>
        matchesStatus(test) &&
        (text === "" || `${testTitle(test)} ${test.file}`.toLowerCase().includes(text)),
    )
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) || order[a.status] - order[b.status] || a.line - b.line,
    );
  const files = [...new Set(shown.map((test) => test.file))];
  const fallback =
    tests.find((test) => test.status === "failed") ??
    tests.find((test) => test.status === "flaky") ??
    tests[0];
  const selected = tests.find((test) => test.id === search.test) ?? fallback;
  const counted = (status?: "failed" | "flaky" | "passed") =>
    tests.filter((test) => status === undefined || test.status === status).length;
  const changed = tests.filter((test) => isChanged(changes, test)).length;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_280px] items-baseline gap-2">
          <h2 id="results-title" className="m-0 text-subheading">
            Playwright results
          </h2>
          <span className="text-label text-fg-muted">
            {shown.length === tests.length
              ? `${count(tests.length)} tests`
              : `${count(shown.length)} of ${count(tests.length)} tests`}
          </span>
        </div>
        <Segmented
          label="Filter by status"
          value={search.status ?? "all"}
          onValueChange={(value) =>
            onSearch({ ...search, status: value === "all" ? undefined : value })
          }
          segments={[
            { value: "all", label: "All", count: counted() },
            { value: "failed", label: "Failed", count: counted("failed") },
            { value: "flaky", label: "Flaky", count: counted("flaky") },
            { value: "passed", label: "Passed", count: counted("passed") },
            ...(changed > 0
              ? [{ value: "changed" as const, label: "Changes", count: changed }]
              : []),
          ]}
        />
        <SearchInput
          label="Filter tests"
          value={search.q ?? ""}
          onValueChange={(value) => onSearch({ ...search, q: value === "" ? undefined : value })}
        />
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <Panel className="flex-[999_1_520px]">
          <Table columns="minmax(0,1fr) 96px 64px 80px" minWidth={520} label="Tests">
            <TableHeader>
              <span className="pl-6">Test</span>
              <span>Browser</span>
              <span className="text-right">Retries</span>
              <span className="text-right">Time</span>
            </TableHeader>
            {shown.length === 0 ? (
              <Empty>No tests match this filter.</Empty>
            ) : (
              files.map((file) => {
                const every = tests.filter((test) => test.file === file);
                const summary = (["failed", "flaky", "passed"] as const)
                  .map(
                    (status) =>
                      [status, every.filter((test) => test.status === status).length] as const,
                  )
                  .filter(([status, n]) => n > 0 || status === "passed")
                  .map(([status, n]) => `${n} ${status}`)
                  .join(", ");
                return (
                  <div key={file} role="rowgroup">
                    <TableGroup>
                      <span className="flex min-w-0 items-center gap-2">
                        <Icon name="file" className="text-fg-muted" />
                        <span className="truncate font-mono text-caption leading-5 font-medium">
                          {file}
                        </span>
                      </span>
                      <span className="col-[2/5] whitespace-nowrap text-right text-caption text-fg-muted">
                        {summary}
                      </span>
                    </TableGroup>
                    {shown
                      .filter((test) => test.file === file)
                      .map((test) => (
                        <button
                          key={`${test.project}:${test.id}`}
                          type="button"
                          role="row"
                          aria-pressed={test === selected}
                          onClick={() => onSearch({ ...search, test: test.id })}
                          className={cn(rowClass(test === selected), "cursor-pointer")}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <StatusIcon status={test.status} />
                            <span className="min-w-0 truncate">{testTitle(test)}</span>
                            {isChanged(changes, test) ? (
                              <span className="flex-none rounded-control bg-running-tint px-1 text-caption text-running">
                                changed
                              </span>
                            ) : null}
                          </span>
                          <span className="whitespace-nowrap text-label text-fg-muted">
                            {browserName(test)}
                          </span>
                          <NumberCell
                            className={test.retries > 0 ? "text-flaky" : "text-fg-subtle"}
                          >
                            {test.retries > 0 ? test.retries : "—"}
                          </NumberCell>
                          <NumberCell>
                            {test.status === "skipped" ? "—" : duration(test.duration)}
                          </NumberCell>
                        </button>
                      ))}
                  </div>
                );
              })
            )}
          </Table>
        </Panel>
        {selected === undefined ? null : (
          <TestPane {...props} search={search} onSearch={onSearch} test={selected} />
        )}
      </div>
    </>
  );
};

const TestPane = ({ org, project, run, test }: Props & { readonly test: Test }) => {
  const attempt = test.attempts.at(-1);
  const error = attempt?.errors[0];
  return (
    <aside
      aria-label="Selected test"
      className="min-w-0 flex-[1_1_400px] overflow-hidden rounded-panel border border-border bg-panel"
    >
      <PanelHeader>
        <StatusPill status={test.status} />
        <Link
          to="/$org/$project/runs/$run/tests/$test"
          params={{ org, project, run, test: test.id }}
          className="whitespace-nowrap text-label font-medium"
        >
          Open test
        </Link>
      </PanelHeader>
      <div className="flex flex-col gap-1 p-4">
        <h3 className="m-0 text-subheading">{testTitle(test)}</h3>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-label text-fg-muted">
          <Mono className="min-w-0 truncate">
            {test.file}:{test.line}
          </Mono>
          <span className="whitespace-nowrap">{browserName(test)}</span>
          <span className="whitespace-nowrap">{retriesLabel(test.retries)}</span>
          <Mono className="whitespace-nowrap">{duration(test.duration)}</Mono>
        </div>
      </div>
      {error === undefined || attempt === undefined ? (
        <p className="m-0 max-w-prose border-t border-border p-4 text-body text-fg-muted">
          {noteOf(test)}
        </p>
      ) : (
        <>
          <PanelSection label="Error">
            <ErrorMessage message={error.message} />
            {error.snippet === undefined ? null : <CodeFrame snippet={error.snippet} />}
          </PanelSection>
          <PanelSection label={`Steps, attempt ${attempt.retry + 1} of ${test.attempts.length}`}>
            <StepList attempt={attempt} />
          </PanelSection>
        </>
      )}
      {attempt === undefined ? null : (
        <PanelSection>
          <Attachments run={run} attempt={attempt} />
        </PanelSection>
      )}
    </aside>
  );
};

const noteOf = (test: Test) => {
  if (test.status === "skipped") return "Skipped: it did not run in this run.";
  if (test.status === "flaky") {
    const failedAttempts = test.attempts.filter((attempt) => attempt.status !== "passed").length;
    return `Failed on ${failedAttempts === 1 ? "attempt 1" : `${failedAttempts} attempts`}, passed on attempt ${test.attempts.length}.`;
  }
  return `Passed on the first attempt in ${duration(test.duration)}.`;
};

// ---------------------------------------------------------------- around the results

const StoriesLink = ({ org, project, row }: Props & { readonly row: RunRow }) => (
  <Panel>
    <PanelHeader title="Stories">
      <Link
        to="/$org/$project/stories"
        params={{ org, project }}
        search={{ run: row.id }}
        className="whitespace-nowrap text-label font-medium"
      >
        Open stories
      </Link>
    </PanelHeader>
    <p className="m-0 p-4 text-body text-fg-muted">This run reported HighAlch stories only.</p>
  </Panel>
);

const FuzzOnCommit = ({ org, project, row }: Props & { readonly row: RunRow }) => {
  const result = useLiveQuery((q) =>
    q.from({
      run: runs.list({
        org: OrganizationId.make(org),
        project: ProjectId.make(project),
        commit: row.commit,
      }),
    }),
  );
  const fuzz = HighAlch.match(result).on({
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) =>
      data.find((candidate) => candidate.kind === "fuzz"),
    orElse: () => undefined,
  });
  if (fuzz === undefined) return null;
  const { ok, overflow, crash, a11y } = fuzz.summary.cases;
  const figures: ReadonlyArray<readonly [string, number, Status | undefined]> = [
    ["Cases", ok + overflow + crash + a11y, undefined],
    ["OK", ok, "passed"],
    ["Overflow", overflow, "flaky"],
    ["A11y", a11y, "running"],
    ["Crash", crash, "failed"],
  ];
  return (
    <Panel aria-labelledby="fuzz-title">
      <PanelHeader id="fuzz-title" title="Fuzzing on this commit">
        <Link
          to="/$org/$project/runs/$run"
          params={{ org, project, run: fuzz.id }}
          className="whitespace-nowrap text-label font-medium"
        >
          Open fuzzing results
        </Link>
      </PanelHeader>
      <div className="flex flex-wrap items-center gap-x-12 gap-y-4 p-4">
        <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1">
          <span className="text-subheading">Run {fuzz.id}</span>
          <Mono className="text-fg-muted">{runResult(fuzz)}</Mono>
        </div>
        <dl className="m-0 flex flex-wrap gap-4">
          {figures.map(([label, value, status]) => (
            <div key={label} className="flex w-24 flex-col gap-1">
              <dt className="flex items-center gap-1 text-label text-fg-muted">
                {status === undefined ? <Slot /> : <Dot status={status} />}
                {label}
              </dt>
              <dd className="m-0 font-mono text-subheading font-medium">{count(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Panel>
  );
};
