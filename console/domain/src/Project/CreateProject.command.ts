import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { TargetMismatch } from "../TargetMismatch.rejection.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId, RepositoryId } from "./Project.id.ts";

export class ProjectExists extends Domain.Rejection("ProjectExists", {}, { httpApiStatus: 409 }) {}

export class ProjectCreated extends Domain.Event("ProjectCreated", {
  org: OrganizationId,
  repository: Schema.NullOr(RepositoryId),
  defaultBranch: Schema.String,
}) {}

/** A member creates a project in their organisation. The slug is the project's id. */
export class CreateProject extends Domain.Command("CreateProject", {
  target: ProjectId,
  middleware: [Caller],
  input: {
    slug: ProjectId,
    org: OrganizationId,
    repository: Schema.NullOr(RepositoryId),
    /** Runs on it are compared with its previous run; pull requests default to it as base. */
    defaultBranch: Schema.String,
  },
  events: [ProjectCreated],
  rejects: [ProjectExists, NotAllowed, TargetMismatch],
}) {}
