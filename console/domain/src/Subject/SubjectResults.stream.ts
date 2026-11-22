import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Count, Millis } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { SnapshotCounts, SubjectKind } from "./Subject.ts";

/** One subject's results in one compared run. */
export const SubjectResultFields = {
  org: OrganizationId,
  project: ProjectId,
  subject: Schema.String,
  kind: SubjectKind,
  name: Schema.String,
  run: Schema.String,
  commit: Schema.String,
  branch: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  completedAt: Millis,
  items: Count,
  failures: Count,
  snapshots: SnapshotCounts,
  schemaHash: Schema.NullOr(Schema.String),
};

export class SubjectResultListed extends Domain.Event("SubjectResultListed", SubjectResultFields) {}

/**
 * Every subject result of a project in completion order: a subject's history is this stream
 * filtered by its id (and branch). Keyed by project, so it never mixes projects or orgs.
 */
export class SubjectResults extends Domain.Stream(
  "SubjectResults",
  { key: ProjectId, entries: [SubjectResultListed] },
  { description: "Per-subject results of a project's runs, oldest first." },
) {}
