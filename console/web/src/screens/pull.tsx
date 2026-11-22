import { runs } from "@highalch/console-domain/Console.collections";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { ProjectId } from "@highalch/console-domain/Project/Project.id";
import * as HighAlch from "@lowalch/tanstack-db";
import { Navigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { FailedPanel, LoadingRows } from "../components/states.tsx";
import { Empty, Panel } from "../components/ui/panel.tsx";

/** A pull request is reviewed on its latest Playwright run (else its latest run of any kind). */
export const PullScreen = ({
  org,
  project,
  pull,
}: {
  readonly org: string;
  readonly project: string;
  readonly pull: number;
}) => {
  const result = useLiveQuery((q) =>
    q
      .from({
        run: runs.list({
          org: OrganizationId.make(org),
          project: ProjectId.make(project),
          pr: pull,
        }),
      })
      .orderBy(({ run }) => run.createdAt, "desc"),
  );
  return HighAlch.match(result).on({
    [HighAlch.anyOf("Loading", "Retrying")]: () => (
      <Panel>
        <LoadingRows label="Loading the pull request" />
      </Panel>
    ),
    Ready: ({ data }) => {
      const latest = data.find((run) => run.kind === "playwright") ?? data[0];
      return latest === undefined ? (
        <Panel>
          <Empty>No runs reported on pull request #{pull} yet.</Empty>
        </Panel>
      ) : (
        <Navigate to="/$org/$project/runs/$run" params={{ org, project, run: latest.id }} replace />
      );
    },
    orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
  });
};
