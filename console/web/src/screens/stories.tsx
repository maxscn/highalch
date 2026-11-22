import { pulls, runs, stories } from "@highalch/console-domain/Console.collections";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { ProjectId } from "@highalch/console-domain/Project/Project.id";
import type { PullRow } from "@highalch/console-domain/Project/Source.rows";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import type { RunRow } from "@highalch/console-domain/Run/Run.rows";
import type { StoryRow } from "@highalch/console-domain/Story/Story.rows";
import * as HighAlch from "@lowalch/tanstack-db";
import { Link, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { BranchInto, Icon } from "../components/icons.tsx";
import { PageHeader, Sep } from "../components/page.tsx";
import { FailedPanel, LoadingRows, Reconnecting } from "../components/states.tsx";
import { Mono } from "../components/ui/chip.tsx";
import { SearchInput } from "../components/ui/input.tsx";
import { Empty, Panel } from "../components/ui/panel.tsx";
import { Segmented } from "../components/ui/segmented.tsx";
import { Dot, Slot, StatusIcon, StatusPill, statusText } from "../components/ui/status.tsx";
import { rowClass, Table, TableGroup, TableHeader } from "../components/ui/table.tsx";
import { age, ago, count, duration, shortSha } from "../lib/format.ts";
import { useNow } from "../lib/now.tsx";
import { cn } from "../lib/cn.ts";
import { commitsOf } from "./runs.tsx";

/** What the stories page keeps in its URL: which run (commit) and the list filter. */
export type StoriesSearch = {
  readonly run?: string | undefined;
  readonly filter?: "failed" | "frames" | "passed" | undefined;
  readonly q?: string | undefined;
};

type Props = {
  readonly org: string;
  readonly project: string;
  readonly search: StoriesSearch;
  readonly onSearch: (next: StoriesSearch) => void;
};

/** Runs that reported stories (`vp test` with HighAlch's report), newest first. */
const storyRuns = (rows: ReadonlyArray<RunRow>) =>
  rows.filter((row) => row.kind === "stories").sort((a, b) => b.createdAt - a.createdAt);

/**
 * Stories of a pull request (Stories board): the run's commit, a summary of its stories and
 * frames, the pull request's commits with their story results, and every story grouped by test
 * file, filtered by outcome or changed frames.
 */
export const StoriesScreen = (props: Props) => {
  const result = useLiveQuery((q) =>
    q.from({
      run: runs.list({
        org: OrganizationId.make(props.org),
        project: ProjectId.make(props.project),
      }),
    }),
  );
  return HighAlch.match(result).on({
    Loading: () => (
      <Panel>
        <LoadingRows label="Loading stories" rows={5} />
      </Panel>
    ),
    Retrying: ({ data }) => (
      <>
        <Reconnecting />
        <Chosen {...props} all={storyRuns(data)} />
      </>
    ),
    Ready: ({ data }) => <Chosen {...props} all={storyRuns(data)} />,
    orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
  });
};

const Chosen = ({ all, ...props }: Props & { readonly all: ReadonlyArray<RunRow> }) => {
  const run =
    all.find((row) => row.id === props.search.run) ?? all.find((row) => row.pr !== null) ?? all[0];
  if (run === undefined)
    return (
      <>
        <PageHeader id="stories-title" title="Stories" />
        <Panel>
          <Empty>
            No stories yet. Run your tests with HIGHALCH_REPORT set and upload the folder.
          </Empty>
        </Panel>
      </>
    );
  return <StoriesOfRun {...props} run={run} all={all} />;
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

const StoriesOfRun = ({
  run,
  all,
  ...props
}: Props & { readonly run: RunRow; readonly all: ReadonlyArray<RunRow> }) => {
  const now = useNow();
  const pull = usePull(props.project, run.pr);
  const commit = run.commitInfo;
  const result = useLiveQuery((q) => q.from({ story: stories.list({ run: RunId.make(run.id) }) }));
  return HighAlch.match(result).on({
    Loading: () => (
      <Panel>
        <LoadingRows label="Loading stories" rows={5} />
      </Panel>
    ),
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) => {
      const failed = data.filter((story) => story.status === "failed");
      return (
        <>
          <PageHeader
            id="stories-title"
            above={
              <>
                {run.pr === null ? <span>{run.branch}</span> : <span>Pull request #{run.pr}</span>}
                <Sep />
                <span>vp test · Run {run.id}</span>
              </>
            }
            title={pull?.title ?? commit?.message ?? `Stories of run ${run.id}`}
            meta={
              <>
                <BranchInto branch={run.branch} base={run.pr === null ? null : run.baseBranch} />
                <Mono className="text-accent">{shortSha(run.commit)}</Mono>
                {commit === null ? null : <span>{commit.author.name}</span>}
                {run.completedAt === null ? null : (
                  <Mono>{duration(run.completedAt - run.createdAt)}</Mono>
                )}
                <span>{ago(run.createdAt, now)}</span>
              </>
            }
            actions={
              failed.length > 0 ? (
                <StatusPill status="failed">
                  {failed.length} {failed.length === 1 ? "story" : "stories"} failed
                </StatusPill>
              ) : data.length > 0 ? (
                <StatusPill status="passed">All passed</StatusPill>
              ) : undefined
            }
          />
          <Summary stories={data} />
          {pull === undefined ? null : <Commits {...props} run={run} all={all} pull={pull} />}
          <StoryList {...props} run={run} stories={data} />
        </>
      );
    },
    orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
  });
};

// ---------------------------------------------------------------- summary

const framesOf = (story: StoryRow) =>
  story.frames.matched +
  story.frames.created +
  story.frames.updated +
  story.frames.missing +
  story.frames.mismatch;

const Summary = ({ stories: rows }: { readonly stories: ReadonlyArray<StoryRow> }) => {
  const failed = rows.filter((story) => story.status === "failed");
  const frames = rows.reduce((n, story) => n + framesOf(story), 0);
  const differ = rows.reduce((n, story) => n + story.frames.mismatch + story.frames.missing, 0);
  const created = rows.reduce((n, story) => n + story.frames.created, 0);
  const generated = rows.filter((story) => story.explore !== null);
  const failingPaths = generated.filter((story) => story.status === "failed");
  const tiles = [
    {
      label: "Stories",
      value: `${rows.length - failed.length} of ${rows.length}`,
      note:
        failed.length === 0
          ? "all passed"
          : `${failed.length} failed · ${failed.map((story) => story.name).join(", ")}`,
      status: failed.length === 0 ? ("passed" as const) : ("failed" as const),
    },
    {
      label: "Frames",
      value: count(frames),
      note:
        differ === 0 && created === 0
          ? "all match their baselines"
          : [
              differ > 0 ? `${differ} differ` : null,
              created > 0 ? `${created} new baselines` : null,
            ]
              .filter((part) => part !== null)
              .join(" · "),
      status:
        differ > 0 ? ("failed" as const) : created > 0 ? ("running" as const) : ("passed" as const),
    },
    {
      label: "Steps",
      value: count(
        rows.reduce(
          (n, story) => n + story.steps.passed + story.steps.failed + story.steps.notRun,
          0,
        ),
      ),
      note: `${count(rows.reduce((n, story) => n + story.steps.passed, 0))} passed`,
      status: failed.length === 0 ? ("passed" as const) : ("failed" as const),
    },
    {
      label: "Generated paths",
      value:
        generated.length === 0
          ? "—"
          : count(generated.reduce((n, story) => n + (story.explore?.of ?? 0), 0)),
      note:
        generated.length === 0
          ? "no generated stories"
          : failingPaths.length === 0
            ? "every path passed"
            : failingPaths
                .map(
                  (story) => `path ${story.explore?.path ?? 0} of ${story.explore?.of ?? 0} failed`,
                )
                .join(" · "),
      status: failingPaths.length === 0 ? ("passed" as const) : ("flaky" as const),
    },
  ];
  return (
    <Panel aria-label="Summary">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="flex min-w-0 flex-col gap-1 border-t border-border p-4 first:border-t-0 sm:border-t-0 sm:border-l sm:first:border-l-0"
          >
            <span className="text-label font-medium text-fg-muted">{tile.label}</span>
            <span className="text-title">{tile.value}</span>
            <span
              className={cn(
                "inline-flex min-w-0 items-center gap-1 text-label",
                tile.status === "passed" ? "text-fg-muted" : statusText(tile.status),
              )}
            >
              <Dot status={tile.status} />
              <span className="min-w-0 truncate">{tile.note}</span>
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
};

// ---------------------------------------------------------------- commits

const Commits = ({
  org,
  project,
  run,
  all,
  pull,
  search,
  onSearch,
}: Props & {
  readonly run: RunRow;
  readonly all: ReadonlyArray<RunRow>;
  readonly pull: PullRow;
}) => {
  const now = useNow();
  const messages = commitsOf(all);
  const navigate = useNavigate();
  // In commit order (the pull request lists them as runs reported them).
  const at = (sha: string) => Date.parse(messages.get(sha)?.committedAt ?? "") || 0;
  const shas = [pull.baseSha, ...[...pull.commits].sort((a, b) => at(a) - at(b))];
  const runOf = (sha: string) => all.find((row) => row.commit === sha);
  return (
    <section aria-labelledby="commits-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 id="commits-title" className="m-0 text-subheading">
          Commits in this pull request
        </h2>
      </div>
      <div className="overflow-x-auto rounded-panel border border-border bg-panel">
        <ol
          className="m-0 grid list-none p-0"
          style={{
            gridTemplateColumns: `repeat(${shas.length}, minmax(176px, 1fr))`,
            minWidth: shas.length * 176,
          }}
        >
          {shas.map((sha, index) => {
            const found = runOf(sha);
            const selected = found?.id === run.id;
            const message = messages.get(sha);
            return (
              <li key={sha} className="flex min-w-0 border-l border-border first:border-l-0">
                <button
                  type="button"
                  aria-pressed={selected}
                  disabled={found === undefined}
                  onClick={() =>
                    found === undefined
                      ? undefined
                      : index === 0 && run.pr !== null
                        ? void navigate({
                            to: "/$org/$project/stories",
                            params: { org, project },
                            search: { ...search, run: found.id },
                          })
                        : onSearch({ ...search, run: found.id })
                  }
                  className={cn(
                    "flex min-w-0 flex-1 cursor-pointer flex-col gap-1 border-0 px-4 py-3 text-left disabled:cursor-default",
                    selected
                      ? "bg-accent-subtle shadow-[inset_0_-2px_0_var(--accent)]"
                      : "bg-panel hover:bg-bg",
                  )}
                >
                  <span className="flex w-full items-center gap-1">
                    {found === undefined ? <Slot /> : <CommitDot run={found} />}
                    <span className="whitespace-nowrap font-mono text-caption leading-5 font-medium text-fg">
                      {index === 0 ? `base ${shortSha(sha)}` : shortSha(sha)}
                    </span>
                    {message === undefined ? null : (
                      <span className="ml-auto whitespace-nowrap text-caption text-fg-subtle">
                        {age(Date.parse(message.committedAt), now)}
                      </span>
                    )}
                  </span>
                  <span className="w-full truncate text-label text-fg">
                    {index === 0 ? `Base: ${pull.base}` : (message?.message ?? "—")}
                  </span>
                  {found === undefined ? (
                    <span className="text-caption text-fg-subtle">No stories</span>
                  ) : (
                    <CommitResult run={found} />
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
};

/** One commit's story outcome, from its run's summary (each slug's latest report). */
const outcomeOf = (run: RunRow) => {
  const { passed, failed, frames } = run.summary.stories;
  const differ = frames.mismatch;
  const created = frames.created;
  const status =
    failed > 0 ? ("failed" as const) : created > 0 ? ("running" as const) : ("passed" as const);
  const text =
    failed > 0
      ? [
          `${failed} failed`,
          differ > 0 ? `${differ} ${differ === 1 ? "frame differs" : "frames differ"}` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ")
      : created > 0
        ? `${created} new frames`
        : `${passed} of ${passed + failed} passed`;
  return { status, text };
};

const CommitDot = ({ run }: { readonly run: RunRow }) => <Dot status={outcomeOf(run).status} />;

const CommitResult = ({ run }: { readonly run: RunRow }) => {
  const outcome = outcomeOf(run);
  return (
    <span
      className={cn(
        "whitespace-nowrap text-caption",
        outcome === undefined
          ? "text-fg-subtle"
          : outcome.status === "failed"
            ? "text-fail"
            : outcome.status === "running"
              ? "text-running"
              : "text-pass",
      )}
    >
      {outcome?.text ?? "…"}
    </span>
  );
};

// ---------------------------------------------------------------- the list

/** Step kinds (`_tag`s, the verbs of their labels) of screen and machine steps. */
const screenKinds = new Set(["Render", "Shot"]);
const machineKinds = new Set(["Start", "Enter", "Send", "Machine", "Asked"]);

/** The kinds of a story's steps, as the list names them. */
export const storyKinds = (story: Pick<StoryRow, "kinds" | "explore">) => {
  const out: Array<string> = [];
  if (story.explore !== null) out.push("Generated");
  if (story.kinds.some((kind) => screenKinds.has(kind))) out.push("Screen");
  if (story.kinds.some((kind) => machineKinds.has(kind))) out.push("Machine");
  if (out.length === 0) out.push("Data");
  return out;
};

const frameNote = (story: StoryRow) => {
  const total = framesOf(story);
  if (total === 0) return { text: "No screen", tone: "text-fg-subtle" };
  if (story.frames.mismatch > 0)
    return {
      text: `${story.frames.mismatch} ${story.frames.mismatch === 1 ? "differs" : "differ"}`,
      tone: "text-fail",
    };
  if (story.frames.missing > 0)
    return { text: `${story.frames.missing} missing`, tone: "text-fail" };
  if (story.frames.created > 0)
    return { text: `${story.frames.created} new baselines`, tone: "text-running" };
  return { text: `${total} match`, tone: "text-fg-muted" };
};

const frameDots = (story: StoryRow) => [
  ...Array.from({ length: story.frames.matched + story.frames.updated }, () => "bg-pass-dot"),
  ...Array.from({ length: story.frames.created }, () => "bg-running-dot"),
  ...Array.from({ length: story.frames.missing + story.frames.mismatch }, () => "bg-fail-dot"),
];

const columns = "minmax(0,1fr) 176px 72px 176px 72px";

const StoryList = ({
  org,
  project,
  run,
  stories: rows,
  search,
  onSearch,
}: Props & { readonly run: RunRow; readonly stories: ReadonlyArray<StoryRow> }) => {
  const text = search.q?.trim().toLowerCase() ?? "";
  const by = {
    all: () => true,
    failed: (story: StoryRow) => story.status === "failed",
    frames: (story: StoryRow) =>
      story.frames.created + story.frames.mismatch + story.frames.missing + story.frames.updated >
      0,
    passed: (story: StoryRow) => story.status === "passed",
  };
  const shown = rows
    .filter(by[search.filter ?? "all"])
    .filter(
      (story) =>
        text === "" || `${story.name} ${story.test?.name ?? ""}`.toLowerCase().includes(text),
    );
  const fileOf = (story: StoryRow) => story.test?.file ?? "Stories without a test";
  const files = [...new Set(shown.map(fileOf))].sort();
  return (
    <section aria-labelledby="list-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_240px] items-baseline gap-2">
          <h2 id="list-title" className="m-0 text-subheading">
            Stories
          </h2>
          <span className="text-label text-fg-muted">
            {shown.length} of {rows.length} stories
          </span>
        </div>
        <Segmented
          label="Filter stories"
          value={search.filter ?? "all"}
          onValueChange={(value) =>
            onSearch({ ...search, filter: value === "all" ? undefined : value })
          }
          segments={[
            { value: "all", label: "All", count: rows.length },
            { value: "failed", label: "Failed", count: rows.filter(by.failed).length },
            { value: "frames", label: "Frames changed", count: rows.filter(by.frames).length },
            { value: "passed", label: "Passed", count: rows.filter(by.passed).length },
          ]}
        />
        <SearchInput
          label="Filter stories"
          value={search.q ?? ""}
          onValueChange={(value) => onSearch({ ...search, q: value === "" ? undefined : value })}
        />
      </div>
      <Panel>
        <Table columns={columns} minWidth={880} label="Stories">
          <TableHeader>
            <span className="pl-6">Story</span>
            <span>Kind</span>
            <span className="text-right">Steps</span>
            <span>Frames</span>
            <span className="text-right">Time</span>
          </TableHeader>
          {shown.length === 0 ? (
            <Empty>
              {rows.length === 0
                ? "This run recorded no stories."
                : "No stories match this filter."}
            </Empty>
          ) : (
            files.map((file) => {
              const inFile = shown.filter((story) => fileOf(story) === file);
              const failed = inFile.filter((story) => story.status === "failed").length;
              return (
                <div key={file} role="rowgroup">
                  <TableGroup>
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon name="file" className="text-fg-muted" />
                      <span className="truncate font-mono text-caption leading-5 font-medium">
                        {file}
                      </span>
                    </span>
                    <span className="col-[2/6] whitespace-nowrap text-right text-caption text-fg-muted">
                      {inFile.length} {inFile.length === 1 ? "story" : "stories"}
                      {failed > 0 ? ` · ${failed} failed` : ""}
                    </span>
                  </TableGroup>
                  {inFile.map((story) => {
                    const note = frameNote(story);
                    return (
                      <Link
                        key={story.id}
                        role="row"
                        to="/$org/$project/runs/$run/stories/$slug"
                        params={{ org, project, run: run.id, slug: story.slug }}
                        className={cn(rowClass(), "h-auto min-h-12 py-1")}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <StatusIcon status={story.status} />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate font-medium">{story.name}</span>
                            <span className="truncate text-caption text-fg-muted">
                              {story.explore === null
                                ? (story.test?.name ?? "")
                                : `explore · ${story.explore.of} paths${story.status === "failed" ? ` · failing path ${story.explore.path} of ${story.explore.of}` : ""}`}
                            </span>
                          </span>
                        </span>
                        <span className="flex flex-wrap gap-1">
                          {storyKinds(story).map((kind) => (
                            <span
                              key={kind}
                              className="inline-flex h-5 items-center rounded-control border border-border bg-subtle px-1.5 text-caption text-fg-muted"
                            >
                              {kind}
                            </span>
                          ))}
                        </span>
                        <span className="text-right font-mono text-caption text-fg-muted">
                          {story.steps.passed} /{" "}
                          {story.steps.passed + story.steps.failed + story.steps.notRun}
                        </span>
                        <span className="flex min-w-0 items-center gap-2">
                          <span aria-hidden="true" className="flex gap-0.5">
                            {frameDots(story).map((tone, index) => (
                              <span key={index} className={cn("h-4 w-2 rounded-[2px]", tone)} />
                            ))}
                          </span>
                          <span className={cn("whitespace-nowrap text-caption", note.tone)}>
                            {note.text}
                          </span>
                        </span>
                        <span className="text-right font-mono text-caption text-fg-muted">
                          {duration(story.durationMs)}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              );
            })
          )}
        </Table>
      </Panel>
    </section>
  );
};
