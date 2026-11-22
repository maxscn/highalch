import * as Domain from "@alchemy.run/domain";
import { Caller } from "../Caller.middleware.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { TargetMismatch } from "../TargetMismatch.rejection.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId, RepositoryId } from "./Project.id.ts";

export class RepositoryTaken extends Domain.Rejection(
  "RepositoryTaken",
  {},
  { httpApiStatus: 409 },
) {}

export class RepositoryClaimed extends Domain.Event("RepositoryClaimed", {
  project: ProjectId,
  org: OrganizationId,
}) {}

export class RepositoryReleased extends Domain.Event("RepositoryReleased", {
  project: ProjectId,
}) {}

/**
 * A repository uploads to exactly one project (GitHub OIDC maps the `repository` claim here).
 * Claimed before the project is created; released if that fails.
 */
export class ClaimRepository extends Domain.Command("ClaimRepository", {
  target: RepositoryId,
  middleware: [Caller],
  input: { repository: RepositoryId, project: ProjectId, org: OrganizationId },
  events: [RepositoryClaimed],
  rejects: [RepositoryTaken, NotAllowed, TargetMismatch],
}) {}

export class ReleaseRepository extends Domain.Command("ReleaseRepository", {
  target: RepositoryId,
  middleware: [Caller],
  input: { repository: RepositoryId, project: ProjectId },
  events: [RepositoryReleased],
  rejects: [NotAllowed, TargetMismatch],
}) {}
