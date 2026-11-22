import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { Count, Millis } from "../Ids.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { RunId } from "../Run/Run.id.ts";
import { CommitInfo, Kind, PullInfo } from "../Run/Run.values.ts";
import { TargetMismatch } from "../TargetMismatch.rejection.ts";
import { NotEntitled } from "./NotEntitled.rejection.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationMissing } from "./OrganizationMissing.rejection.ts";
import { QuotaExceeded } from "./QuotaExceeded.rejection.ts";

/** What a run is about: its project, commit, branch, pull request and kind. */
export const RunContext = {
  project: ProjectId,
  commit: Schema.String,
  branch: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  source: Schema.String,
  kind: Kind,
  /** Branch whose latest completed run is the snapshot baseline. */
  baseBranch: Schema.String,
  commitInfo: Schema.NullOr(CommitInfo),
  pull: Schema.NullOr(PullInfo),
};

/** A run's context as one value: what `RunIntake` creates the run from. */
export const RunContextStruct = Schema.Struct(RunContext);
export type RunContextStruct = typeof RunContextStruct.Type;

/** A run was admitted; `RunIntake` creates it. A GitHub OIDC upload's context is the verified one. */
export class RunOpened extends Domain.Event("RunOpened", {
  run: RunId,
  period: Millis,
  ...RunContext,
}) {}

/**
 * The run's slot is free again: it completed, expired, or could not be created. `writes` is how
 * many uploads (artifact declarations, results batches, stories) the organisation accepted for
 * it: the run completes once it has applied them all, whatever order they reach it in.
 */
export class RunClosed extends Domain.Event("RunClosed", {
  run: RunId,
  writes: Count,
  context: RunContextStruct,
}) {}

/**
 * CI starts a run of a project (`run` is a fresh id it chose): needs a current paid period, a
 * free run slot and run allowance. The run's later uploads go to this organisation too.
 */
export class OpenRun extends Domain.Command("OpenRun", {
  target: OrganizationId,
  middleware: [Caller],
  input: { org: OrganizationId, run: RunId, ...RunContext },
  events: [RunOpened],
  rejects: [OrganizationMissing, NotAllowed, NotEntitled, QuotaExceeded, TargetMismatch],
}) {}

/** CI finished the run. Completing a run that is not open (any more) changes nothing. */
export class CompleteRun extends Domain.Command("CompleteRun", {
  target: OrganizationId,
  middleware: [Caller],
  input: { org: OrganizationId, run: RunId },
  events: [RunClosed],
  rejects: [OrganizationMissing, NotAllowed, TargetMismatch],
}) {}

/** Free the run's slot (it completed or expired). Never refused; a repeat changes nothing. */
export class CloseRun extends Domain.Command("CloseRun", {
  target: OrganizationId,
  input: { run: RunId },
  events: [RunClosed],
  rejects: [],
}) {}
