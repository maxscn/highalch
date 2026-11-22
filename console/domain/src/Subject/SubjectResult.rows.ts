import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Schema from "effect/Schema";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { Run } from "../Run/Run.aggregate.ts";
import { RunId } from "../Run/Run.id.ts";
import { subjectId } from "./Subject.ts";
import { SubjectResultFields } from "./SubjectResults.stream.ts";

/** A subject's results in one compared run. `id` is `<run>/<subject>`. */
export const SubjectResultRow = Schema.Struct({
  id: Schema.String,
  ...SubjectResultFields,
  run: RunId,
});
export type SubjectResultRow = typeof SubjectResultRow.Type;

export const subjectResultId = (run: string, subject: string) => `${run}/${subject}`;

/** Every subject's results per compared run: a subject's history. */
export class SubjectResultRows extends HighAlch.Rows("SubjectResultRows", {
  feed: OrganizationChanges,
  row: SubjectResultRow,
  key: "id",
  from: [Run],
  scope: ({ event }) => (event._tag === "ComparisonRecorded" ? event.org : undefined),
  on: {
    ComparisonRecorded: (event, { source }) =>
      event.subjects.map((tally) => {
        const subject = subjectId(event.project, tally.kind, tally.name);
        return HighAlch.upserted({
          id: subjectResultId(source.id, subject),
          org: event.org,
          project: event.project,
          subject,
          kind: tally.kind,
          name: tally.name,
          run: source.id,
          commit: event.commit,
          branch: event.branch,
          pr: event.pr,
          completedAt: event.completedAt,
          items: tally.items,
          failures: tally.failures,
          snapshots: tally.snapshots,
          schemaHash: tally.schemaHash,
        });
      }),
  },
}) {}
