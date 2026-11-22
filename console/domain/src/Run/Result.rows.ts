import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Schema from "effect/Schema";
import { Count } from "../Ids.ts";
import { Organization } from "../Organization/Organization.aggregate.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { Run } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";
import { ResultPart } from "./Run.values.ts";

/**
 * One stored results object of a run (its items stay in storage; `ResultPartLinks` signs a
 * link to read them): which part, where, and how many items. `key` is its storage key.
 * `snapshots` is the run's snapshot map, `removed.*` the baseline's items the run no longer has.
 */
export const ResultRow = Schema.Struct({
  key: Schema.String,
  run: RunId,
  org: OrganizationId,
  project: ProjectId,
  part: ResultPart.fields.part,
  count: Count,
  /** The items paid for: readers show at most these and say the rest were not processed. */
  charged: Count,
});
export type ResultRow = typeof ResultRow.Type;

/** The stored results objects of an organisation's runs. */
export class ResultRows extends HighAlch.Rows("ResultRows", {
  feed: OrganizationChanges,
  row: ResultRow,
  key: "key",
  from: [Organization, Run],
  scope: ({ event, source }) => {
    if (event._tag === "ResultsAccepted") return OrganizationId.make(source.id);
    if (event._tag === "ComparisonRecorded") return event.org;
    return undefined;
  },
  on: {
    ResultsAccepted: (event, { source }) =>
      event.parts.map(({ part, key, count, charged }) =>
        HighAlch.upserted({
          key,
          part,
          count,
          charged,
          run: event.run,
          org: source.id,
          project: event.project,
        }),
      ),
    ComparisonRecorded: (event, { source }) =>
      event.parts.map((part) =>
        HighAlch.upserted({ ...part, run: source.id, org: event.org, project: event.project }),
      ),
  },
}) {}
