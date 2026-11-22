import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Count, Millis } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { RunId } from "./Run.id.ts";
import { CompletionReason, Kind, Summary } from "./Run.values.ts";

/** The run is final. Carries everything a listing needs. */
export class RunCompleted extends Domain.Event("RunCompleted", {
  org: OrganizationId,
  project: ProjectId,
  commit: Schema.String,
  branch: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  source: Schema.String,
  kind: Kind,
  baseBranch: Schema.String,
  createdAt: Millis,
  summary: Summary,
  reason: CompletionReason,
}) {}

/** The run completes once it has applied this many uploads; some have not reached it yet. */
export class RunClosing extends Domain.Event("RunClosing", { expected: Count }) {}

/**
 * The client completed the run (`CompleteRun`) after its organisation accepted `writes`
 * uploads for it. Sent by `RunIntake` only. The run completes now if it has applied them all,
 * else with the last of them; a repeat changes nothing.
 */
export class FinishRun extends Domain.Command("FinishRun", {
  target: RunId,
  input: { org: OrganizationId, writes: Count },
  events: [RunCompleted, RunClosing],
  rejects: [],
}) {}

/** Deadline: a run still open this long after creation is completed by the server. */
export class ExpireRun extends Domain.Command("ExpireRun", {
  target: RunId,
  input: {},
  events: [RunCompleted],
  rejects: [],
}) {}
