import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Millis } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { Kind, Summary } from "./Run.values.ts";

/** A completed run, with everything a run list shows. */
export class RunListed extends Domain.Event("RunListed", {
  run: Schema.String,
  project: ProjectId,
  commit: Schema.String,
  branch: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  source: Schema.String,
  kind: Kind,
  createdAt: Millis,
  completedAt: Millis,
  summary: Summary,
  baseline: Schema.NullOr(Schema.String),
}) {}

/**
 * Completed runs of an organisation in completion order, listed once their snapshot
 * comparison is recorded (so the entry carries the final summary). Filtered by project, commit, PR and
 * branch for the run lists; the retention job walks it oldest first.
 */
export class OrganizationRuns extends Domain.Stream(
  "OrganizationRuns",
  { key: OrganizationId, entries: [RunListed] },
  { description: "Completed runs of an organisation, in completion order." },
) {}
