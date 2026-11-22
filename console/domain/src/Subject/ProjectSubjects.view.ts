import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Count, Millis } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { Run } from "../Run/Run.aggregate.ts";
import { SnapshotCounts, subjectId, SubjectKind } from "./Subject.ts";

/** Subjects listed per project at most (state stays bounded; history is kept for all). */
export const maxSubjects = 5_000;

export const LatestResult = Schema.Struct({
  run: Schema.String,
  commit: Schema.String,
  branch: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  completedAt: Millis,
  items: Count,
  failures: Count,
  snapshots: SnapshotCounts,
  schemaHash: Schema.NullOr(Schema.String),
});

export const SubjectEntry = Schema.Struct({
  id: Schema.String,
  kind: SubjectKind,
  name: Schema.String,
  latest: LatestResult,
});
export type SubjectEntry = typeof SubjectEntry.Type;

/** A project's subjects with the latest results of each. */
export class ProjectSubjects extends Domain.View(
  "ProjectSubjects",
  {
    from: [Run],
    key: ProjectId,
    keyOf: { ComparisonRecorded: ({ event }) => event.project },
    state: Schema.Struct({
      org: Schema.NullOr(OrganizationId),
      subjects: Schema.Array(SubjectEntry),
    }),
    initial: { org: null, subjects: [] },
    evolve: {
      ComparisonRecorded: (state, e, { source }) => {
        const byId = new Map(state.subjects.map((s) => [s.id, s]));
        for (const tally of e.subjects) {
          const id = subjectId(e.project, tally.kind, tally.name);
          if (!byId.has(id) && byId.size >= maxSubjects) continue;
          const previous = byId.get(id);
          if (previous && previous.latest.completedAt > e.completedAt) continue;
          byId.set(id, {
            id,
            kind: tally.kind,
            name: tally.name,
            latest: {
              run: source.id,
              commit: e.commit,
              branch: e.branch,
              pr: e.pr,
              completedAt: e.completedAt,
              items: tally.items,
              failures: tally.failures,
              snapshots: tally.snapshots,
              schemaHash: tally.schemaHash,
            },
          });
        }
        return { org: e.org, subjects: [...byId.values()] };
      },
    },
  },
  { description: "A project's subjects (components, parts, pages) with their latest results." },
) {}
