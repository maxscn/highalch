import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { RunCompleted } from "./FinishRun.command.ts";
import { Count, Millis } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { RunId } from "./Run.id.ts";
import { CaseCounts, PendingUpload, ResultPart, TestCounts, TraceCounts } from "./Run.values.ts";

export class ResultsRecorded extends Domain.Event("ResultsRecorded", {
  org: OrganizationId,
  period: Millis,
  parts: Schema.Array(ResultPart),
  /** The objects to verify once their links expired. */
  uploads: Schema.Array(PendingUpload),
  tests: TestCounts,
  cases: CaseCounts,
  traces: TraceCounts,
  bytes: Count,
}) {}

/** Record a results batch its organisation accepted. Sent by `RunIntake` only. */
export class AddResults extends Domain.Command("AddResults", {
  target: RunId,
  input: {
    org: OrganizationId,
    period: Millis,
    parts: Schema.Array(ResultPart),
    uploads: Schema.Array(PendingUpload),
    tests: TestCounts,
    cases: CaseCounts,
    traces: TraceCounts,
    bytes: Count,
  },
  events: [ResultsRecorded, RunCompleted],
  rejects: [],
  /** Whether the run took it: `false` once it completed (expired) or for another organisation. */
  reply: { applied: Schema.Boolean },
}) {}
