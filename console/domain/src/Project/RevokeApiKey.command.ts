import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { TargetMismatch } from "../TargetMismatch.rejection.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "./Project.id.ts";
import { ProjectMissing } from "./ProjectMissing.rejection.ts";

export class ApiKeyMissing extends Domain.Rejection("ApiKeyMissing", {}, { httpApiStatus: 404 }) {}

export class ApiKeyRevoked extends Domain.Event("ApiKeyRevoked", {
  org: OrganizationId,
  key: Schema.String,
}) {}

export class RevokeApiKey extends Domain.Command("RevokeApiKey", {
  target: ProjectId,
  middleware: [Caller],
  input: { project: ProjectId, key: Schema.String },
  events: [ApiKeyRevoked],
  rejects: [ProjectMissing, NotAllowed, ApiKeyMissing, TargetMismatch],
}) {}
