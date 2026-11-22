import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Schema from "effect/Schema";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { RunFields, type RunInfo } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";
import { Outcome, outcomeOf } from "./Run.values.ts";
import { RunDetail } from "./RunDetail.view.ts";

/**
 * A run: its commit context, status, summary counts (stories included), snapshot baseline, and
 * how it went (`outcome`: running, passed, or failed when anything it reported failed).
 */
const { storyCounts: _, ...shown } = RunFields;

export const RunRow = Schema.Struct({ id: RunId, ...shown, outcome: Outcome });
export type RunRow = typeof RunRow.Type;

export const runRow = (id: RunId, run: RunInfo): RunRow => {
  const { _tag: __, storyCounts: ___, ...fields } = run;
  return { id, ...fields, outcome: outcomeOf(run) };
};

/** The runs of an organisation, from creation on, after every change. */
export class RunRows extends HighAlch.Rows("RunRows", {
  feed: OrganizationChanges,
  row: RunRow,
  key: "id",
  from: [RunDetail],
  scope: ({ state }) => (state?._tag === "Run" ? state.org : undefined),
  on: {
    RunDetail: (event, { source, state }) =>
      state?._tag === "Run" && event._tag !== "StoryRecorded"
        ? HighAlch.upserted(runRow(source.id, state))
        : undefined,
  },
}) {}
