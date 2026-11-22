import { runs } from "@highalch/console-domain/Console.collections";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { ProjectId } from "@highalch/console-domain/Project/Project.id";
import type { RunRow } from "@highalch/console-domain/Run/Run.rows";
import * as HighAlch from "@lowalch/tanstack-db";
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { Icon } from "../components/icons.tsx";
import { PageHeader } from "../components/page.tsx";
import { FailedPanel, LoadingRows, Reconnecting } from "../components/states.tsx";
import { Chip } from "../components/ui/chip.tsx";
import { Panel, Empty } from "../components/ui/panel.tsx";
import { SearchInput } from "../components/ui/input.tsx";
import { Segmented } from "../components/ui/segmented.tsx";
import { InlineStatus, type Status } from "../components/ui/status.tsx";
import { NumberCell, rowClass, Table, TableHeader } from "../components/ui/table.tsx";
import { ago, duration, plural, shortSha } from "../lib/format.ts";
import { useNow } from "../lib/now.tsx";
import { runResult, runStatus } from "../lib/outcome.ts";

/** How each run kind is named. */
export const kindLabel: Record<RunRow["kind"], string> = {
  playwright: "Playwright",
  fuzz: "Fuzz",
  stories: "Stories",
};

export type RunsFilter = {
  readonly q?: string | undefined;
  readonly status?: "failed" | "flaky" | "passed" | undefined;
  readonly kind?: RunRow["kind"] | undefined;
};

const columns = "112px minmax(0,1fr) 240px 200px 72px 104px";

/** Every run of a project, newest first, filtered by text, outcome and kind (in the URL). */
export const RunsScreen = ({
  org,
  project,
  filter,
  onFilter,
}: {
  readonly org: string;
  readonly project: string;
  readonly filter: RunsFilter;
  readonly onFilter: (next: RunsFilter) => void;
}) => {
  const result = useLiveQuery((q) =>
    q
      .from({ run: runs.list({ org: OrganizationId.make(org), project: ProjectId.make(project) }) })
      .orderBy(({ run }) => run.createdAt, "desc")
      .orderBy(({ run }) => run.id, "desc"),
  );
  const listed = (rows: ReadonlyArray<RunRow>) =>
    rows.map((run) => ({ run, commit: run.commitInfo }));
  return (
    <>
      <PageHeader
        id="runs-title"
        title="Runs"
        meta={<span>Every Playwright, fuzz and story upload for this project, newest first.</span>}
      />
      {HighAlch.match(result).on({
        Loading: () => (
          <Panel>
            <LoadingRows label="Loading runs" rows={6} />
          </Panel>
        ),
        Retrying: ({ data }) => (
          <>
            <Reconnecting />
            <RunTable
              org={org}
              project={project}
              rows={listed(data)}
              filter={filter}
              onFilter={onFilter}
            />
          </>
        ),
        Ready: ({ data }) => (
          <RunTable
            org={org}
            project={project}
            rows={listed(data)}
            filter={filter}
            onFilter={onFilter}
          />
        ),
        orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
      })}
    </>
  );
};

/** What an upload reported of a commit: its message, author and time (display only). */
export type CommitInfo = NonNullable<RunRow["commitInfo"]>;

/** The commits a set of runs reported, by SHA. */
export const commitsOf = (rows: ReadonlyArray<RunRow>): ReadonlyMap<string, CommitInfo> =>
  new Map(
    rows.flatMap((run) => (run.commitInfo === null ? [] : [[run.commit, run.commitInfo] as const])),
  );

type Listed = { readonly run: RunRow; readonly commit: CommitInfo | null };

const matches = ({ run, commit }: Listed, filter: RunsFilter) => {
  const status = runStatus(run);
  if (filter.status !== undefined && status !== filter.status) return false;
  if (filter.kind !== undefined && run.kind !== filter.kind) return false;
  const text = filter.q?.trim().toLowerCase();
  if (text === undefined || text === "") return true;
  const pr = text.startsWith("#") ? Number(text.slice(1)) : Number.NaN;
  return (
    run.commit.startsWith(text) ||
    run.branch.toLowerCase().includes(text) ||
    run.pr === pr ||
    run.id.includes(text) ||
    (commit?.message.toLowerCase().includes(text) ?? false)
  );
};

const RunTable = ({
  org,
  project,
  rows,
  filter,
  onFilter,
}: {
  readonly org: string;
  readonly project: string;
  readonly rows: ReadonlyArray<Listed>;
  readonly filter: RunsFilter;
  readonly onFilter: (next: RunsFilter) => void;
}) => {
  const now = useNow();
  const shown = rows.filter((row) => matches(row, filter));
  const counted = (status?: Status) =>
    rows.filter(({ run }) => status === undefined || runStatus(run) === status).length;
  return (
    <section aria-label="Runs" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SearchInput
          label="Search commit, branch or #PR"
          className="w-72"
          value={filter.q ?? ""}
          onValueChange={(value) => onFilter({ ...filter, q: value === "" ? undefined : value })}
        />
        <Segmented
          label="Filter by outcome"
          value={filter.status ?? "all"}
          onValueChange={(value) =>
            onFilter({ ...filter, status: value === "all" ? undefined : value })
          }
          segments={[
            { value: "all", label: "All", count: counted() },
            { value: "failed", label: "Failed", count: counted("failed") },
            { value: "flaky", label: "Flaky", count: counted("flaky") },
            { value: "passed", label: "Passed", count: counted("passed") },
          ]}
        />
        <Segmented
          label="Filter by kind"
          value={filter.kind ?? "all"}
          onValueChange={(value) =>
            onFilter({ ...filter, kind: value === "all" ? undefined : value })
          }
          segments={[
            { value: "all", label: "All kinds" },
            { value: "playwright", label: "Playwright" },
            { value: "fuzz", label: "Fuzz" },
            { value: "stories", label: "Stories" },
          ]}
        />
      </div>
      <Panel>
        <Table columns={columns} minWidth={960} label="Runs">
          <TableHeader>
            <span className="pl-6">Status</span>
            <span>Commit</span>
            <span>Branch</span>
            <span>Results</span>
            <span className="text-right">Time</span>
            <span className="text-right">Started</span>
          </TableHeader>
          {shown.length === 0 ? (
            <Empty>
              {rows.length === 0
                ? "No runs yet. CI uploads appear here."
                : "No runs match this filter."}
            </Empty>
          ) : (
            shown.map(({ run, commit }) => {
              const status = runStatus(run);
              return (
                <Link
                  key={run.id}
                  role="row"
                  to="/$org/$project/runs/$run"
                  params={{ org, project, run: run.id }}
                  className={rowClass()}
                >
                  <InlineStatus status={status} />
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{commit?.message ?? `Run ${run.id}`}</span>
                    <span className="font-mono text-caption text-fg-muted">
                      {shortSha(run.commit)}
                    </span>
                    <Chip className="h-5 px-1 text-caption">{kindLabel[run.kind]}</Chip>
                  </span>
                  <span className="flex min-w-0 items-center gap-2 text-fg-muted">
                    <Icon name={run.pr === null ? "branch" : "pulls"} />
                    {run.pr === null ? null : (
                      <span className="font-mono text-caption text-accent">#{run.pr}</span>
                    )}
                    <span className="min-w-0 truncate font-mono text-caption">{run.branch}</span>
                  </span>
                  <span className="min-w-0 truncate text-label text-fg-muted">
                    {runResult(run)}
                  </span>
                  <NumberCell>
                    {run.completedAt === null ? "—" : duration(run.completedAt - run.createdAt)}
                  </NumberCell>
                  <span className="whitespace-nowrap text-right text-label text-fg-muted">
                    {ago(run.createdAt, now)}
                  </span>
                </Link>
              );
            })
          )}
        </Table>
      </Panel>
      <span className="text-caption text-fg-subtle">
        {plural(shown.length, "run")} shown of {rows.length}
      </span>
    </section>
  );
};
