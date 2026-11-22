import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Schema from "effect/Schema";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { ProjectSubjects, SubjectEntry } from "./ProjectSubjects.view.ts";
import { subjectId } from "./Subject.ts";

/** A subject of a project (component, part or page) with its latest results. */
export const SubjectRow = Schema.Struct({
  ...SubjectEntry.fields,
  org: OrganizationId,
  project: ProjectId,
});
export type SubjectRow = typeof SubjectRow.Type;

/** The subjects of an organisation's projects, after each compared run that tallied them. */
export class SubjectRows extends HighAlch.Rows("SubjectRows", {
  feed: OrganizationChanges,
  row: SubjectRow,
  key: "id",
  from: [ProjectSubjects],
  scope: ({ state }) => state?.org ?? undefined,
  on: {
    ComparisonRecorded: (event, { state }) => {
      if (state === null || state.org === null) return undefined;
      const org = state.org;
      const tallied = new Set(
        event.subjects.map((tally) => subjectId(event.project, tally.kind, tally.name)),
      );
      return state.subjects
        .filter((subject) => tallied.has(subject.id))
        .map((subject) => HighAlch.upserted({ ...subject, org, project: event.project }));
    },
  },
}) {}
