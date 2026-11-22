import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Schema from "effect/Schema";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { Run } from "../Run/Run.aggregate.ts";
import { Person, PullInfo } from "../Run/Run.values.ts";
import { ProjectId } from "./Project.id.ts";
import { SourceHistory, type KnownPull } from "./SourceHistory.view.ts";

/** A commit an upload reported (display only). `id` is `<project>/<sha>`. */
export const CommitRow = Schema.Struct({
  id: Schema.String,
  org: OrganizationId,
  project: ProjectId,
  sha: Schema.String,
  message: Schema.String,
  author: Person,
  committedAt: Schema.String,
});
export type CommitRow = typeof CommitRow.Type;

export const commitId = (project: string, sha: string) => `${project}/${sha}`;

/** The commits of an organisation's projects, as their uploads reported them (latest wins). */
export class CommitRows extends HighAlch.Rows("CommitRows", {
  feed: OrganizationChanges,
  row: CommitRow,
  key: "id",
  from: [Run],
  scope: ({ event }) =>
    event._tag === "RunCreated" && event.commitInfo !== null ? event.org : undefined,
  on: {
    RunCreated: (event) =>
      event.commitInfo === null
        ? undefined
        : HighAlch.upserted({
            id: commitId(event.project, event.commit),
            org: event.org,
            project: event.project,
            sha: event.commit,
            ...event.commitInfo,
          }),
  },
}) {}

/** A pull request an upload reported, with the commits that had runs on it, oldest first. */
export const PullRow = Schema.Struct({
  id: Schema.String,
  org: OrganizationId,
  project: ProjectId,
  number: Schema.Number,
  branch: Schema.String,
  ...PullInfo.fields,
  commits: Schema.Array(Schema.String),
});
export type PullRow = typeof PullRow.Type;

export const pullId = (project: string, number: number) => `${project}#${number}`;

export const pullRow = (org: OrganizationId, project: ProjectId, pull: KnownPull): PullRow => ({
  id: pullId(project, pull.number),
  org,
  project,
  number: pull.number,
  branch: pull.branch,
  ...pull.info,
  commits: pull.commits,
});

/** The pull requests of an organisation's projects, after every run reported on them. */
export class PullRows extends HighAlch.Rows("PullRows", {
  feed: OrganizationChanges,
  row: PullRow,
  key: "id",
  from: [SourceHistory],
  scope: ({ state }) => state?.org ?? undefined,
  on: {
    RunCreated: (event, { state }) => {
      if (state === null || state.org === null || event.pr === null) return undefined;
      const pull = state.pulls.find((p) => p.number === event.pr);
      return pull === undefined
        ? undefined
        : HighAlch.upserted(pullRow(state.org, event.project, pull));
    },
  },
}) {}
