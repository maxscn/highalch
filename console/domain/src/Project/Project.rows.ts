import * as HighAlch from "@lowalch/tanstack-db/server";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Millis } from "../Ids.ts";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { Project, type ActiveProject } from "./Project.aggregate.ts";
import { ProjectId, RepositoryId } from "./Project.id.ts";

/** A project: the unit runs are reported to. Its slug is unique across HighAlch Console. */
export const ProjectRow = Schema.Struct({
  slug: ProjectId,
  org: OrganizationId,
  /** The repository whose GitHub Actions OIDC tokens may upload to it. */
  repository: Schema.NullOr(RepositoryId),
  defaultBranch: Schema.String,
  createdAt: Millis,
});
export type ProjectRow = typeof ProjectRow.Type;

export const projectRow = (slug: ProjectId, p: ActiveProject): ProjectRow => ({
  slug,
  org: p.org,
  repository: p.repository,
  defaultBranch: p.defaultBranch,
  createdAt: p.createdAt,
});

/**
 * The projects of an organisation. Rows come from the project's own events (which carry the
 * whole row), so a client's command settles as soon as the feed passed its receipt.
 */
export class ProjectRows extends HighAlch.Rows("ProjectRows", {
  feed: OrganizationChanges,
  row: ProjectRow,
  key: "slug",
  from: [Project],
  scope: ({ event }) =>
    event._tag === "ProjectCreated" || event._tag === "RepositoryBound" ? event.org : undefined,
  on: {
    ProjectCreated: (event, { source, envelope }) =>
      HighAlch.upserted({
        slug: source.id,
        org: event.org,
        repository: event.repository,
        defaultBranch: event.defaultBranch,
        createdAt: DateTime.toEpochMillis(envelope.at),
      }),
    RepositoryBound: (event, { source }) =>
      HighAlch.upserted({
        slug: source.id,
        org: event.org,
        repository: event.repository,
        defaultBranch: event.defaultBranch,
        createdAt: event.createdAt,
      }),
  },
}) {}
