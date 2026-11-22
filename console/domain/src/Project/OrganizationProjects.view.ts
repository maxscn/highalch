import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Millis } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { Project } from "./Project.aggregate.ts";
import { ProjectId, RepositoryId } from "./Project.id.ts";

export const ProjectEntry = Schema.Struct({
  slug: ProjectId,
  repository: Schema.NullOr(RepositoryId),
  defaultBranch: Schema.String,
  createdAt: Millis,
});
export type ProjectEntry = typeof ProjectEntry.Type;

/** The projects of an organisation, oldest first. */
export class OrganizationProjects extends Domain.View(
  "OrganizationProjects",
  {
    from: [Project],
    key: OrganizationId,
    keyOf: { ProjectCreated: ({ event }) => event.org, RepositoryBound: ({ event }) => event.org },
    state: Schema.Struct({ projects: Schema.Array(ProjectEntry) }),
    initial: { projects: [] },
    evolve: {
      ProjectCreated: (state, event, { source, at }) => ({
        projects: [
          ...state.projects.filter((p) => p.slug !== source.id),
          {
            slug: source.id,
            repository: event.repository,
            defaultBranch: event.defaultBranch,
            createdAt: DateTime.toEpochMillis(at),
          },
        ],
      }),
      RepositoryBound: (state, event, { source }) => ({
        projects: state.projects.map((p) =>
          p.slug === source.id ? { ...p, repository: event.repository } : p,
        ),
      }),
    },
  },
  { description: "The projects of an organisation." },
) {}
