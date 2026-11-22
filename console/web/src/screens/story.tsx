import {
  artifactLinks,
  artifacts,
  runs,
  stories,
} from "@highalch/console-domain/Console.collections";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { ProjectId } from "@highalch/console-domain/Project/Project.id";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import type { RunRow } from "@highalch/console-domain/Run/Run.rows";
import type { StoryRow } from "@highalch/console-domain/Story/Story.rows";
import * as HighAlch from "@lowalch/tanstack-db";
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { Suspense, use, useState, type ReactNode } from "react";
import { Arrow, Icon } from "../components/icons.tsx";
import { FailedPanel, LoadingRows } from "../components/states.tsx";
import { Button } from "../components/ui/button.tsx";
import { Mono } from "../components/ui/chip.tsx";
import { Empty, Panel } from "../components/ui/panel.tsx";
import { Segmented } from "../components/ui/segmented.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Dot, Slot, StatusPill, statusText, type Status } from "../components/ui/status.tsx";
import { documentOf, elementsOf } from "../data/items.ts";
import { rowText, shownSteps, StoryReport, type ShownStep, type World } from "../data/report.ts";
import { count, duration, shortSha } from "../lib/format.ts";
import { cn } from "../lib/cn.ts";
import { storyKinds } from "./stories.tsx";

type Props = {
  readonly org: string;
  readonly project: string;
  readonly run: string;
  readonly slug: string;
  /** The selected step; the failing step (or the last with a frame) when absent. */
  readonly step?: number | undefined;
  readonly onStep: (step: number) => void;
};

/**
 * One story (Story and StoryFailure boards): its filmstrip, its steps, and after the selected
 * step the screen it painted (against the base branch's frame) and the world: sources and their
 * rows, commands, the wires, the rules judged. A failed story leads with what failed, and the history of
 * the row that broke the rule.
 */
export const StoryScreen = (props: Props) => {
  const run = useLiveQuery((q) =>
    q.from({ run: runs.get({ run: RunId.make(props.run) }) }).findOne(),
  );
  const story = useLiveQuery((q) =>
    q.from({ story: stories.list({ run: RunId.make(props.run) }) }),
  );
  return HighAlch.match(run).on({
    [HighAlch.anyOf("Loading", "Retrying")]: () => <StoryLoading />,
    Missing: () => (
      <Panel>
        <Empty>Run {props.run} doesn't exist, or it was deleted.</Empty>
      </Panel>
    ),
    Ready: ({ data: row }) =>
      HighAlch.match(story).on({
        Loading: () => <StoryLoading />,
        [HighAlch.anyOf("Ready", "Retrying")]: ({ data: list }) => {
          const found = list.find((candidate) => candidate.slug === props.slug);
          return found === undefined ? (
            <Panel>
              <Empty>
                Run {props.run} has no story “{props.slug}”.
              </Empty>
            </Panel>
          ) : (
            <Report {...props} row={row} story={found} />
          );
        },
        orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
      }),
    orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
  });
};

const StoryLoading = () => (
  <Panel>
    <LoadingRows label="Loading the story" rows={5} />
  </Panel>
);

/**
 * A story's steps live in its report (`story.json`, an artifact of the run), not in rows: its
 * signed link, then the report itself (Suspense), then the run's artifacts to find each frame.
 */
const Report = ({
  row,
  story,
  ...props
}: Props & { readonly row: RunRow; readonly story: StoryRow }) => {
  const link = useLiveQuery((q) =>
    q.from({ links: artifactLinks({ run: RunId.make(props.run), ids: [story.report] }) }),
  );
  return HighAlch.match(link).on({
    Loading: () => <StoryLoading />,
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) => {
      const url = data.flatMap((answer) => elementsOf(answer))[0]?.link?.url;
      return url === undefined ? (
        <Panel>
          <Empty>This story's report is not stored (yet), or retention removed it.</Empty>
        </Panel>
      ) : (
        <Suspense fallback={<StoryLoading />}>
          <Loaded
            {...props}
            row={row}
            story={story}
            report={documentOf(StoryReport, { key: story.report, link: { url } })}
          />
        </Suspense>
      );
    },
    orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
  });
};

const Loaded = ({
  report,
  ...props
}: Props & {
  readonly row: RunRow;
  readonly story: StoryRow;
  readonly report: ReturnType<typeof documentOf<StoryReport, unknown>>;
}) => {
  const loaded = use(report);
  const declared = useLiveQuery((q) =>
    q.from({ artifact: artifacts.list({ run: RunId.make(props.run) }) }),
  );
  return HighAlch.match(loaded).on({
    Document: ({ value }) =>
      value === null ? (
        <Panel>
          <Empty>This story's report is empty.</Empty>
        </Panel>
      ) : (
        HighAlch.match(declared).on({
          Loading: () => <StoryLoading />,
          [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) => {
            const bySha = new Map(data.map((artifact) => [artifact.sha256, artifact.id]));
            return (
              <StoryPage
                {...props}
                report={value}
                steps={shownSteps(value, (sha256) => bySha.get(sha256))}
              />
            );
          },
          orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
        })
      ),
    ItemsUnavailable: (error) => <FailedPanel error={error} />,
    ItemsUndecodable: (error) => <FailedPanel error={error} />,
  });
};

type Step = ShownStep;

const StoryPage = ({
  row,
  story,
  steps,
  report,
  ...props
}: Props & {
  readonly row: RunRow;
  readonly story: StoryRow;
  readonly steps: ReadonlyArray<Step>;
  readonly report: StoryReport;
}) => {
  const failedAt = story.failure?.step;
  const lastFramed = [...steps].reverse().find((step) => step.frame !== null)?.n;
  const selected = props.step ?? failedAt ?? lastFramed ?? steps.at(-1)?.n ?? 1;
  const current = steps.find((step) => step.n === selected) ?? steps[0];
  const base = useBaseRun(props.org, props.project, row);
  const ids = steps.flatMap((step) =>
    step.frame === null || step.frame.artifact === null ? [] : [step.frame.artifact],
  );
  const links = useLiveQuery((q) =>
    ids.length === 0
      ? undefined
      : q.from({ links: artifactLinks({ run: RunId.make(props.run), ids: ids.slice(0, 100) }) }),
  );
  const urls = HighAlch.match(links).on({
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) =>
      new Map(
        data
          .flatMap((answer) => elementsOf(answer))
          .flatMap((entry) => (entry.link === null ? [] : [[entry.id, entry.link.url] as const])),
      ),
    orElse: () => new Map<string, string>(),
  });
  const framed = steps.filter((step) => step.frame !== null);
  return (
    <>
      <Header {...props} row={row} story={story} steps={steps} />
      {report.failure === undefined ? null : (
        <FailureBox report={report} onOpen={() => props.onStep(story.failure?.step ?? 1)} />
      )}
      {report.explore === undefined ? null : <Explore story={story} report={report} />}
      {framed.length === 0 ? null : (
        <Filmstrip
          steps={steps}
          framed={framed}
          urls={urls}
          selected={selected}
          onStep={props.onStep}
        />
      )}
      <div className="flex flex-wrap items-start gap-4">
        <StepList steps={steps} selected={selected} onStep={props.onStep} />
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
          {current === undefined || framed.length === 0 ? null : (
            <Frame
              step={current}
              url={current.frame?.artifact == null ? undefined : urls.get(current.frame.artifact)}
              base={base}
              slug={story.slug}
              firstFrame={framed[0]?.n ?? 0}
            />
          )}
          {current === undefined ? null : current.world === null ? (
            <Panel>
              <Empty>Step {current.n} did not run, so it has no world.</Empty>
            </Panel>
          ) : (
            <WorldView world={current.world} step={current} story={story} report={report} />
          )}
        </div>
      </div>
    </>
  );
};

// ---------------------------------------------------------------- header

const Header = ({
  org,
  project,
  row,
  story,
  steps,
}: Omit<Props, "onStep"> & {
  readonly row: RunRow;
  readonly story: StoryRow;
  readonly steps: ReadonlyArray<Step>;
}) => (
  <section
    aria-labelledby="story-title"
    className="flex flex-wrap items-start justify-between gap-4"
  >
    <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-2 text-label text-fg-muted">
        <Link
          to="/$org/$project/stories"
          params={{ org, project }}
          search={{ run: row.id }}
          className="inline-flex items-center gap-1 font-medium"
        >
          <Icon name="back" className="self-center" />
          Stories
        </Link>
        {story.test === null ? null : (
          <>
            <span aria-hidden="true">·</span>
            <Mono>{story.test.file}</Mono>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">{story.test.name}</span>
          </>
        )}
      </div>
      <h1 id="story-title" className="m-0 text-title">
        {story.name}
      </h1>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-fg-muted">
        {story.status === "passed" ? (
          <span className="inline-flex items-center gap-1 font-medium text-pass">
            <Icon name="passed" />
            Passed
          </span>
        ) : (
          <StatusPill status="failed">Failed at step {story.failure?.step ?? "?"}</StatusPill>
        )}
        <span>
          {story.host === "memory"
            ? "Memory host"
            : story.host === "custom"
              ? "Custom host"
              : "No host"}
        </span>
        <span>
          Scope <Mono>{story.scope}</Mono>
        </span>
        <span>{story.clock === "manual" ? "Manual clock" : "Real clock"}</span>
        <span>
          {story.invariants.length} {story.invariants.length === 1 ? "rule" : "rules"}
        </span>
        <span>
          {steps.filter((step) => step.status === "passed").length} of {steps.length} steps passed
        </span>
        <Mono>{duration(story.durationMs)}</Mono>
        <Mono className="text-accent">{shortSha(row.commit)}</Mono>
      </div>
    </div>
    <div className="flex flex-wrap gap-2">
      {storyKinds(story).map((kind) => (
        <span
          key={kind}
          className="inline-flex h-6 items-center rounded-control border border-border bg-subtle px-2 text-label text-fg-muted"
        >
          {kind}
        </span>
      ))}
    </div>
  </section>
);

const FailureBox = ({
  report,
  onOpen,
}: {
  readonly report: StoryReport;
  readonly onOpen: () => void;
}) => {
  const failure = report.failure;
  if (failure === undefined) return null;
  return (
    <section
      aria-labelledby="failure-title"
      className="overflow-hidden rounded-panel border border-fail-dot bg-panel"
    >
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-4 border-b border-border bg-fail-tint px-4 py-1">
        <h2
          id="failure-title"
          className="m-0 flex items-center gap-2 text-body font-semibold text-fail"
        >
          <Icon name="failed" />
          Step {failure.step} failed
        </h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() =>
              void navigator.clipboard.writeText([failure.reason, ...failure.detail].join("\n"))
            }
          >
            <Icon name="copy" />
            Copy failure
          </Button>
          <Button size="sm" onClick={onOpen}>
            Open at step {failure.step}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 p-4">
        <p className="m-0 max-w-prose text-body">{failure.reason}</p>
        {failure.detail.length === 0 ? null : (
          <pre className="m-0 overflow-x-auto rounded-control border border-border bg-bg px-4 py-2 font-mono text-label whitespace-pre-wrap [overflow-wrap:anywhere]">
            {failure.detail.join("\n")}
          </pre>
        )}
      </div>
    </section>
  );
};

const Explore = ({ story, report }: { readonly story: StoryRow; readonly report: StoryReport }) => {
  const explore = report.explore;
  if (explore === undefined) return null;
  const events = (list: ReadonlyArray<string>, highlight: ReadonlyArray<string>) => (
    <span className="flex flex-wrap items-center gap-1">
      {list.map((event, index) => (
        <span key={index} className="flex items-center gap-1">
          <span
            className={cn(
              "inline-flex h-6 items-center rounded-control px-2 font-mono text-caption",
              highlight.includes(event) ? "bg-fail-tint text-fail" : "bg-subtle text-fg-muted",
            )}
          >
            {event}
          </span>
          {index < list.length - 1 ? (
            <span className="text-fg-subtle">
              <Arrow />
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
  return (
    <section
      aria-labelledby="explore-title"
      className="overflow-hidden rounded-panel border border-border bg-panel"
    >
      <div className="flex h-10 items-center justify-between gap-4 border-b border-border bg-bg px-4">
        <h2 id="explore-title" className="m-0 text-body font-semibold">
          Explored by <Mono>{explore.name}</Mono>
        </h2>
        <span
          className={cn("text-label", story.status === "failed" ? "text-fail" : "text-fg-muted")}
        >
          {story.status === "failed"
            ? `Sequence ${explore.index} of ${explore.of} failed (${explore.level})`
            : `Sequence ${explore.index} of ${explore.of} replayed (${explore.level})`}
        </span>
      </div>
      <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-4 gap-y-2 p-4 text-label">
        {explore.shrunkFrom.length === explore.moves.length ? null : (
          <>
            <dt className="text-fg-muted">Found</dt>
            <dd className="m-0">{events(explore.shrunkFrom, explore.moves)}</dd>
          </>
        )}
        <dt className="text-fg-muted">
          {explore.shrunkFrom.length === explore.moves.length ? "Sequence" : "Shrunk to"}
        </dt>
        <dd className="m-0">{events(explore.moves, [])}</dd>
      </dl>
    </section>
  );
};

// ---------------------------------------------------------------- filmstrip and steps

const stepStatus = (step: Step): Status =>
  step.status === "passed" ? "passed" : step.status === "failed" ? "failed" : "skipped";

const frameStatus = (step: Step): Status => {
  const status = step.frame?.status;
  if (status === undefined) return "skipped";
  if (status === "mismatch" || status === "missing") return "failed";
  if (status === "created" || status === "updated") return "running";
  return "passed";
};

const Filmstrip = ({
  steps,
  framed,
  urls,
  selected,
  onStep,
}: {
  readonly steps: ReadonlyArray<Step>;
  readonly framed: ReadonlyArray<Step>;
  readonly urls: ReadonlyMap<string, string>;
  readonly selected: number;
  readonly onStep: (step: number) => void;
}) => {
  const differ = framed.filter((step) => frameStatus(step) === "failed").length;
  const created = framed.filter((step) => step.frame?.status === "created").length;
  const first = framed[0]?.n ?? 0;
  return (
    <section aria-labelledby="film-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 id="film-title" className="m-0 text-subheading">
          Filmstrip
        </h2>
        <span className="text-label text-fg-muted">
          {count(framed.length)} frames ·{" "}
          {differ > 0
            ? `${differ} ${differ === 1 ? "differs" : "differ"} from the baseline`
            : created > 0
              ? `${created} new baselines`
              : "all match their baselines"}
        </span>
      </div>
      <div className="overflow-x-auto rounded-panel border border-border bg-panel">
        <ol className="m-0 flex list-none gap-4 p-4">
          {steps.map((step) => {
            const url = step.frame?.artifact == null ? undefined : urls.get(step.frame.artifact);
            const on = step.n === selected;
            return (
              <li key={step.n} className="flex-none">
                <button
                  type="button"
                  aria-pressed={on}
                  aria-label={`Step ${step.n}: ${step.kind}`}
                  onClick={() => onStep(step.n)}
                  className="flex cursor-pointer flex-col gap-2 border-0 bg-transparent p-0 text-left"
                >
                  <span
                    className={cn(
                      "block h-[120px] w-[216px] overflow-hidden rounded-control bg-subtle",
                      on ? "shadow-[0_0_0_2px_var(--accent)]" : "shadow-[0_0_0_1px_var(--border)]",
                    )}
                  >
                    {url !== undefined ? (
                      <img
                        src={url}
                        alt=""
                        className="block h-full w-full object-cover object-top"
                      />
                    ) : (
                      <span className="grid h-full w-full place-items-center p-4 text-center text-caption text-fg-subtle">
                        {step.status === "not-run"
                          ? "Not run."
                          : step.n < first
                            ? `No frame yet. The screen mounts at step ${first}.`
                            : "No frame at this step."}
                      </span>
                    )}
                  </span>
                  <span className="flex w-[216px] items-center gap-1">
                    {step.frame === null ? <Slot /> : <Dot status={frameStatus(step)} />}
                    <Mono className="text-fg-muted">{step.n}</Mono>
                    <span className="min-w-0 flex-1 truncate text-label">{step.kind}</span>
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

const StepList = ({
  steps,
  selected,
  onStep,
}: {
  readonly steps: ReadonlyArray<Step>;
  readonly selected: number;
  readonly onStep: (step: number) => void;
}) => {
  const passed = steps.filter((step) => step.status === "passed").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const skipped = steps.length - passed - failed;
  return (
    <section
      aria-labelledby="steps-title"
      className="min-w-0 max-w-[400px] flex-[1_1_360px] overflow-hidden rounded-panel border border-border bg-panel"
    >
      <div className="flex h-10 items-center justify-between border-b border-border px-4">
        <h2 id="steps-title" className="m-0 text-label font-medium text-fg-muted">
          Steps
        </h2>
        <span className="text-caption text-fg-muted">
          {failed === 0
            ? `${passed} of ${steps.length} passed`
            : `${passed} passed · ${failed} failed${skipped > 0 ? ` · ${skipped} not run` : ""}`}
        </span>
      </div>
      <ol className="m-0 list-none py-1">
        {steps.map((step) => {
          const on = step.n === selected;
          const status = stepStatus(step);
          return (
            <li key={step.n}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onStep(step.n)}
                className={cn(
                  "grid w-full cursor-pointer grid-cols-[16px_24px_minmax(0,1fr)] items-start gap-2 border-0 px-4 py-2 text-left",
                  on
                    ? "bg-accent-subtle shadow-selected"
                    : status === "failed"
                      ? "bg-fail-tint"
                      : "bg-transparent hover:bg-bg",
                )}
              >
                <span className={cn("grid h-5 place-items-center", statusText(status))}>
                  <Icon
                    name={status === "passed" ? "check" : status === "failed" ? "cross" : "minus"}
                    label={step.status}
                  />
                </span>
                <span className="text-right font-mono text-caption leading-5 text-fg-subtle">
                  {step.n}
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex h-5 flex-none items-center rounded-control border border-border bg-subtle px-1.5 font-mono text-caption text-fg-muted">
                      {step.kind}
                    </span>
                    {step.durationMs === null ? null : (
                      <Mono className="text-fg-subtle">{duration(step.durationMs)}</Mono>
                    )}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-caption [overflow-wrap:anywhere]",
                      status === "skipped" ? "text-fg-subtle" : "text-fg",
                    )}
                  >
                    {step.label}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

// ---------------------------------------------------------------- the frame

/** The latest story run on the base branch before this one: where baselines are compared from. */
const useBaseRun = (org: string, project: string, row: RunRow) => {
  const result = useLiveQuery((q) =>
    q.from({
      run: runs.list({
        org: OrganizationId.make(org),
        project: ProjectId.make(project),
        branch: row.baseBranch,
      }),
    }),
  );
  return HighAlch.match(result).on({
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) =>
      data
        .filter(
          (candidate) =>
            candidate.source === row.source &&
            candidate.id !== row.id &&
            candidate.createdAt < row.createdAt,
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0],
    orElse: () => undefined,
  });
};

type Mode = "current" | "baseline" | "both";

const Frame = ({
  step,
  url,
  base,
  slug,
  firstFrame,
}: {
  readonly step: Step;
  readonly url: string | undefined;
  readonly base: RunRow | undefined;
  readonly slug: string;
  readonly firstFrame: number;
}) => {
  const [mode, setMode] = useState<Mode>("current");
  const status = frameStatus(step);
  const label =
    step.frame === null
      ? "No frame"
      : step.frame.status === "mismatch"
        ? `Differs · ${count(step.frame.differing ?? 0)} px`
        : step.frame.status === "created"
          ? "New baseline"
          : step.frame.status === "missing"
            ? "No baseline"
            : "Matches baseline";
  return (
    <section
      aria-labelledby="frame-title"
      className="overflow-hidden rounded-panel border border-border bg-panel"
    >
      <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-1">
        <h2 id="frame-title" className="m-0 text-label font-medium text-fg-muted">
          Screen after step <Mono>{step.n}</Mono>
        </h2>
        <span
          className={cn(
            "inline-flex items-center gap-1 text-label",
            step.frame === null ? "text-fg-muted" : statusText(status),
          )}
        >
          {step.frame === null ? <Slot /> : <Dot status={status} />}
          {label}
        </span>
        <Mono className="ml-auto text-fg-subtle">
          {step.frame === null ? "—" : `${slug}/${step.frame.file}`}
        </Mono>
        {base === undefined || step.frame === null ? null : (
          <Segmented
            label="Frame view"
            size="sm"
            value={mode}
            onValueChange={setMode}
            segments={[
              { value: "current", label: "Current" },
              { value: "baseline", label: "Baseline" },
              { value: "both", label: "Side by side" },
            ]}
          />
        )}
      </div>
      <div className="flex flex-wrap justify-center gap-6 bg-subtle px-4 py-6">
        {step.frame === null ? (
          <Pane caption="No frame">
            <span className="grid h-full place-items-center p-6 text-center text-label text-fg-muted">
              {step.n < firstFrame
                ? `Nothing is mounted yet: the screen mounts at step ${firstFrame}.`
                : "No frame was captured after this step."}
            </span>
          </Pane>
        ) : (
          <>
            {mode !== "current" && base !== undefined ? (
              <BaseFrame base={base} slug={slug} step={step.n} file={step.frame.file} />
            ) : null}
            {mode !== "baseline" ? (
              <Pane
                caption={`Current · this run${step.frame.differing === null ? "" : ` · ${count(step.frame.differing)} px differ`}`}
              >
                {url === undefined ? (
                  <Skeleton className="m-6 w-32" />
                ) : (
                  <img
                    src={url}
                    alt={`Screen after step ${step.n}`}
                    className="block h-full w-full"
                  />
                )}
              </Pane>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
};

const Pane = ({
  caption,
  children,
}: {
  readonly caption: string;
  readonly children: ReactNode;
}) => (
  <figure className="m-0 flex flex-col gap-2">
    <div className="h-[200px] w-[360px] overflow-hidden rounded-control bg-bg outline outline-1 outline-border">
      {children}
    </div>
    <figcaption className="text-caption text-fg-muted">{caption}</figcaption>
  </figure>
);

/** The same story's frame at the same step on the base branch's latest story run. */
const BaseFrame = ({
  base,
  slug,
  step,
  file,
}: {
  readonly base: RunRow;
  readonly slug: string;
  readonly step: number;
  readonly file: string;
}) => {
  // The base run's upload of the same frame file of the same story.
  const declared = useLiveQuery((q) =>
    q.from({ artifact: artifacts.list({ run: RunId.make(base.id) }) }),
  );
  const artifact = HighAlch.match(declared).on({
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) =>
      data.find((candidate) => candidate.name === `${slug}/${file}`)?.id ?? null,
    orElse: () => null,
  });
  const links = useLiveQuery((q) =>
    artifact === null
      ? undefined
      : q.from({ links: artifactLinks({ run: RunId.make(base.id), ids: [artifact] }) }),
  );
  const url = HighAlch.match(links).on({
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) =>
      data.flatMap((answer) => elementsOf(answer))[0]?.link?.url,
    orElse: () => undefined,
  });
  return (
    <Pane caption={`Baseline · ${base.baseBranch} at ${shortSha(base.commit)}`}>
      {url === undefined ? (
        <span className="grid h-full place-items-center p-6 text-center text-label text-fg-muted">
          {artifact === null ? "The base branch has no frame at this step." : "Loading…"}
        </span>
      ) : (
        <img src={url} alt={`Baseline after step ${step}`} className="block h-full w-full" />
      )}
    </Pane>
  );
};

// ---------------------------------------------------------------- the world

const writeTone = (pending: boolean, status: Status = "passed") => (pending ? "flaky" : status);

const WorldView = ({
  world,
  step,
  story,
  report,
}: {
  readonly world: World;
  readonly step: Step;
  readonly story: StoryRow;
  readonly report: StoryReport | null;
}) => {
  const held = world.rules.filter((rule) => rule.held).length;
  const command = world.commands.at(-1);
  const wire = world.wires[0];
  const failing = story.failure?.step === step.n;
  const broken = world.rules.find((rule) => !rule.held);
  return (
    <section aria-labelledby="world-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 id="world-title" className="m-0 text-subheading">
          World after step <Mono className="text-body">{step.n}</Mono>
        </h2>
        <span className="text-label text-fg-muted">
          Story clock <Mono>{duration(step.clock ?? 0)}</Mono> ·{" "}
          {step.rest === false
            ? "not at rest"
            : world.wires.length > 0
              ? "at rest, every feed live"
              : "server idle"}
        </span>
      </div>
      <Panel>
        <div className="flex h-10 items-center border-b border-border px-4">
          <h3 className="m-0 text-label font-medium text-fg-muted">Sources</h3>
        </div>
        {world.sources.length === 0 ? (
          <p className="m-0 p-4 text-label text-fg-muted">
            No source is open in a client yet. The history is on the server only.
          </p>
        ) : (
          world.sources.map((source) => {
            const state = typeof source.state === "string" ? source.state : source.state._tag;
            const tone: Status =
              state === "Ready"
                ? "passed"
                : state === "Retrying" || state === "Loading"
                  ? "running"
                  : "failed";
            return (
              <div key={`${source.scope}:${source.id}`}>
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                  <Mono className="text-fg">{source.id}</Mono>
                  <span
                    className={cn("inline-flex items-center gap-1 text-label", statusText(tone))}
                  >
                    <Dot status={tone} />
                    {state}
                  </span>
                  <span className="ml-auto text-caption text-fg-muted">
                    as {source.scope} · {source.rows.length}{" "}
                    {source.rows.length === 1 ? "row" : "rows"}
                    {source.truncated ? " (first 200)" : ""}
                  </span>
                </div>
                <div className="grid h-8 grid-cols-[64px_minmax(0,1fr)_200px] items-center gap-4 border-b border-border bg-bg px-4 text-caption font-medium text-fg-muted">
                  <span>Key</span>
                  <span>Row</span>
                  <span>Writes</span>
                </div>
                {source.rows.map((shown) => {
                  const tone = writeTone(
                    shown.pending,
                    failing && shown.pending && broken !== undefined ? "failed" : "passed",
                  );
                  return (
                    <div
                      key={shown.key}
                      className={cn(
                        "grid min-h-10 grid-cols-[64px_minmax(0,1fr)_200px] items-center gap-4 border-b border-border px-4 last:border-b-0",
                        shown.pending ? "bg-flaky-tint" : "",
                      )}
                    >
                      <Mono className="text-fg-muted">{shown.key}</Mono>
                      <Mono className="truncate text-fg">{rowText(shown.row)}</Mono>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 text-label",
                          statusText(tone),
                        )}
                      >
                        <Dot status={tone} />
                        {shown.pending
                          ? failing && broken !== undefined
                            ? "Still pending at rest"
                            : "Pending · $hasPendingWrites"
                          : "Committed"}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </Panel>
      {failing && broken !== undefined && report !== null ? (
        <RowHistory report={report} world={world} />
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        <Panel>
          <div className="flex h-10 items-center border-b border-border px-4">
            <h3 className="m-0 text-label font-medium text-fg-muted">Commands</h3>
          </div>
          <div className="flex flex-col gap-1 px-4 py-3">
            {command === undefined ? (
              <>
                <span className="text-label text-fg-muted">No command sent yet</span>
                <span className="inline-flex items-center gap-1 text-label text-fg-muted">
                  <Dot status="skipped" />
                  Nothing in flight
                </span>
              </>
            ) : (
              <>
                <Mono className="text-fg [overflow-wrap:anywhere]">{command.label}</Mono>
                <CommandState outcome={command.outcome} />
              </>
            )}
          </div>
        </Panel>
        <Panel>
          <div className="flex h-10 items-center border-b border-border px-4">
            <h3 className="m-0 text-label font-medium text-fg-muted">Wire</h3>
          </div>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 px-4 py-3 text-label">
            <dt className="text-fg-muted">Feed</dt>
            <dd className="m-0 inline-flex items-center gap-1">
              {wire === undefined ? (
                <span className="text-fg-muted">Not opened</span>
              ) : (
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    statusText(wire.feed === "live" ? "passed" : "failed"),
                  )}
                >
                  <Dot status={wire.feed === "live" ? "passed" : "failed"} />
                  {wire.scope} · {wire.feed}
                  {wire.held > 0 ? ` · ${wire.held} held` : ""}
                </span>
              )}
            </dd>
            <dt className="text-fg-muted">Sent</dt>
            <dd className="m-0 font-mono text-caption">
              {wire === undefined ? "—" : `${wire.sent} command(s)`}
            </dd>
            <dt className="text-fg-muted">Queries</dt>
            <dd className="m-0">
              {wire === undefined || wire.asked.length === 0 ? "None asked" : wire.asked.join(", ")}
            </dd>
          </dl>
        </Panel>
        <Panel>
          <div className="flex h-10 items-center justify-between border-b border-border px-4">
            <h3 className="m-0 text-label font-medium text-fg-muted">Rules</h3>
            <span
              className={cn(
                "text-caption",
                held === world.rules.length ? "text-pass" : "text-fail",
              )}
            >
              {world.rules.length === 0
                ? "None judged"
                : held === world.rules.length
                  ? `${held} of ${held} held`
                  : `${world.rules.length - held} broken`}
            </span>
          </div>
          <ul className="m-0 flex list-none flex-col px-4 py-2">
            {world.rules.map((rule) => (
              <li key={rule.name} className="flex min-h-7 items-center gap-2">
                <Icon
                  name={rule.held ? "check" : "cross"}
                  label={rule.held ? "Held" : "Broken"}
                  className={rule.held ? "text-pass" : "text-fail"}
                />
                <Mono className="text-fg">{rule.name}</Mono>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      {world.machines.length === 0 ? null : (
        <Panel>
          <div className="flex h-10 items-center border-b border-border px-4">
            <h3 className="m-0 text-label font-medium text-fg-muted">Machines</h3>
          </div>
          {world.machines.map((machine) => (
            <dl
              key={machine.name}
              className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-1 px-4 py-3 text-label"
            >
              <dt className="text-fg-muted">{machine.name}</dt>
              <dd className="m-0">
                {machine.mode} · <Mono>{JSON.stringify(machine.state)}</Mono>
              </dd>
              <dt className="text-fg-muted">Context</dt>
              <dd className="m-0">
                <Mono className="[overflow-wrap:anywhere]">{rowText(machine.context)}</Mono>
              </dd>
            </dl>
          ))}
        </Panel>
      )}
    </section>
  );
};

const CommandState = ({ outcome }: { readonly outcome: World["commands"][number]["outcome"] }) => {
  const text =
    outcome._tag === "Pending"
      ? "In flight · optimistic row shown"
      : outcome._tag === "Rejected"
        ? `Rejected · ${outcome.error._tag}`
        : outcome._tag === "Died"
          ? `Died · ${outcome.message}`
          : outcome._tag;
  const status: Status =
    outcome._tag === "Pending"
      ? "running"
      : outcome._tag === "Committed"
        ? "passed"
        : outcome._tag === "Unconfirmed"
          ? "flaky"
          : "failed";
  return (
    <span className={cn("inline-flex items-center gap-1 text-label", statusText(status))}>
      <Dot status={status} />
      {text}
    </span>
  );
};

/** What the row that broke a rule showed, in order (StoryFailure board). */
const RowHistory = ({ report, world }: { readonly report: StoryReport; readonly world: World }) => {
  const pending = world.sources.flatMap((source) =>
    source.rows.filter((shown) => shown.pending).map((shown) => ({ source, key: shown.key })),
  )[0];
  const history = report.histories.find((candidate) => candidate.id === pending?.source.id);
  if (pending === undefined || history === undefined) return null;
  const shown = history.shown.filter((entry) => entry.key === pending.key);
  return (
    <Panel>
      <div className="flex h-10 items-center gap-2 border-b border-border px-4">
        <h3 className="m-0 text-label font-medium text-fg-muted">
          What row <Mono className="text-fg">{pending.key}</Mono> showed, in order
        </h3>
        <Mono className="ml-auto text-fg-subtle">{history.id}</Mono>
      </div>
      <div className="grid h-8 grid-cols-[48px_minmax(0,1fr)_200px] items-center gap-4 border-b border-border bg-bg px-4 text-caption font-medium text-fg-muted">
        <span>Step</span>
        <span>Row</span>
        <span>Writes</span>
      </div>
      {shown.map((entry, index) => {
        const last = index === shown.length - 1;
        const tone: Status = entry.pending === true ? (last ? "failed" : "flaky") : "passed";
        return (
          <div
            key={entry.tick}
            className={cn(
              "grid min-h-10 grid-cols-[48px_minmax(0,1fr)_200px] items-center gap-4 border-b border-border px-4 last:border-b-0",
              last && entry.pending === true ? "bg-fail-tint" : "",
            )}
          >
            <Mono className="text-fg-muted">{entry.step}</Mono>
            <Mono className="truncate">
              {entry.removed === true ? "removed" : rowText(entry.row)}
            </Mono>
            <span className={cn("inline-flex items-center gap-1 text-label", statusText(tone))}>
              <Dot status={tone} />
              {entry.pending === true ? (last ? "Still pending at rest" : "Pending") : "Committed"}
            </span>
          </div>
        );
      })}
    </Panel>
  );
};
