import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { Millis } from "../Ids.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { TargetMismatch } from "../TargetMismatch.rejection.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId, RepositoryId } from "./Project.id.ts";
import { ProjectMissing } from "./ProjectMissing.rejection.ts";

/** The project's repository changed; carries the whole project row after it. */
export class RepositoryBound extends Domain.Event("RepositoryBound", {
  org: OrganizationId,
  repository: Schema.NullOr(RepositoryId),
  defaultBranch: Schema.String,
  createdAt: Millis,
}) {}

/** Point an existing project at a repository (claimed first), or at none. */
export class BindRepository extends Domain.Command("BindRepository", {
  target: ProjectId,
  middleware: [Caller],
  input: { project: ProjectId, repository: Schema.NullOr(RepositoryId) },
  events: [RepositoryBound],
  rejects: [ProjectMissing, NotAllowed, TargetMismatch],
}) {}
