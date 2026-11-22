import { pulls, runs } from "@highalch/console-domain/Console.collections";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { ProjectId } from "@highalch/console-domain/Project/Project.id";
import type { PullRow } from "@highalch/console-domain/Project/Source.rows";
import type { RunRow } from "@highalch/console-domain/Run/Run.rows";
import * as HighAlch from "@lowalch/tanstack-db";
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { BranchInto } from "../components/icons.tsx";
import { PageHeader } from "../components/page.tsx";
import { FailedPanel, LoadingRows, Reconnecting } from "../components/states.tsx";
import { Chip } from "../components/ui/chip.tsx";
import { Empty, Panel } from "../components/ui/panel.tsx";
import { InlineStatus } from "../components/ui/status.tsx";
import { NumberCell, rowClass, Table, TableHeader } from "../components/ui/table.tsx";
import { ago, plural } from "../lib/format.ts";
import { useNow } from "../lib/now.tsx";
import { runResult, runStatus } from "../lib/outcome.ts";

const columns = "112px minmax(0,1fr) 280px 200px 88px 104px";

/** A project's pull requests, newest first, each with its latest run's outcome. */
export const PullsScreen = ({
  org,
  project,
}: {
  readonly org: string;
  readonly project: string;
}) => {
  const list = useLiveQuery((q) =>
    q
      .from({ pull: pulls.list({ project: ProjectId.make(project) }) })
      .orderBy(({ pull }) => pull.number, "desc"),
  );
  const recent = useLiveQuery((q) =>
    q.from({ run: runs.list({ org: OrganizationId.make(org), project: ProjectId.make(project) }) }),
  );
  const latest = HighAlch.match(recent).on({
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) => data,
    orElse: () => [],
  });
  return (
    <>
      <PageHeader
        id="pulls-title"
        title="Pull requests"
        meta={<span>Every pull request CI reported runs on.</span>}
      />
      {HighAlch.match(list).on({
        Loading: () => (
          <Panel>
            <LoadingRows label="Loading pull requests" rows={4} />
          </Panel>
        ),
        Retrying: ({ data }) => (
          <>
            <Reconnecting />
            <PullTable org={org} project={project} rows={data} runs={latest} />
          </>
        ),
        Ready: ({ data }) => <PullTable org={org} project={project} rows={data} runs={latest} />,
        orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
      })}
    </>
  );
};

const PullTable = ({
  org,
  project,
  rows,
  runs: all,
}: {
  readonly org: string;
  readonly project: string;
  readonly rows: ReadonlyArray<PullRow>;
  readonly runs: ReadonlyArray<RunRow>;
}) => {
  const now = useNow();
  return (
    <Panel>
      <Table columns={columns} minWidth={960} label="Pull requests">
        <TableHeader>
          <span className="pl-6">Latest run</span>
          <span>Pull request</span>
          <span>Branch</span>
          <span>Result</span>
          <span className="text-right">Commits</span>
          <span className="text-right">Updated</span>
        </TableHeader>
        {rows.length === 0 ? (
          <Empty>No pull requests yet: runs on a pull request's branch appear here.</Empty>
        ) : (
          rows.map((pull) => {
            const latest = all
              .filter((run) => run.pr === pull.number)
              .sort((a, b) => b.createdAt - a.createdAt)[0];
            return (
              <Link
                key={pull.id}
                role="row"
                to="/$org/$project/pulls/$pull"
                params={{ org, project, pull: String(pull.number) }}
                className={rowClass()}
              >
                {latest === undefined ? (
                  <span className="pl-6 text-fg-subtle">—</span>
                ) : (
                  <InlineStatus status={runStatus(latest)} />
                )}
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-mono text-caption text-fg-muted">#{pull.number}</span>
                  <span className="min-w-0 truncate">{pull.title}</span>
                  {pull.state === "open" ? null : (
                    <Chip className="h-5 px-1 text-caption">
                      {pull.state === "merged" ? "Merged" : "Closed"}
                    </Chip>
                  )}
                </span>
                <span className="min-w-0 truncate text-fg-muted">
                  <BranchInto branch={pull.branch} base={pull.base} />
                </span>
                <span className="min-w-0 truncate text-label text-fg-muted">
                  {latest === undefined ? "No runs" : runResult(latest)}
                </span>
                <NumberCell>{plural(pull.commits.length, "commit")}</NumberCell>
                <span className="whitespace-nowrap text-right text-label text-fg-muted">
                  {latest === undefined ? "—" : ago(latest.createdAt, now)}
                </span>
              </Link>
            );
          })
        )}
      </Table>
    </Panel>
  );
};
