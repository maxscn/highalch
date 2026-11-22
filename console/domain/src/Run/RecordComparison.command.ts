import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Count, Millis } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { SnapshotCounts, SubjectTally } from "../Subject/Subject.ts";
import { RunId } from "./Run.id.ts";
import { ResultPart } from "./Run.values.ts";

/** The run's captures were compared with its baseline (null: no baseline, everything `new`). */
export class ComparisonRecorded extends Domain.Event("ComparisonRecorded", {
  org: OrganizationId,
  project: ProjectId,
  baseline: Schema.NullOr(RunId),
  commit: Schema.String,
  branch: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  completedAt: Millis,
  counts: SnapshotCounts,
  subjects: Schema.Array(SubjectTally),
  parts: Schema.Array(ResultPart),
  bytes: Count,
  /** Items in the run's results objects beyond what was charged: never processed. */
  truncated: Count,
}) {}

/** Sent once by `SnapshotComparison` after completion; a repeat records nothing. */
export class RecordComparison extends Domain.Command("RecordComparison", {
  target: RunId,
  input: {
    baseline: Schema.NullOr(RunId),
    counts: SnapshotCounts,
    subjects: Schema.Array(SubjectTally),
    parts: Schema.Array(ResultPart),
    bytes: Count,
    truncated: Count,
  },
  events: [ComparisonRecorded],
  rejects: [],
}) {}
