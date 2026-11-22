import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { TargetMismatch } from "../TargetMismatch.rejection.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "./Project.id.ts";
import { ProjectMissing } from "./ProjectMissing.rejection.ts";

export class TooManyApiKeys extends Domain.Rejection(
  "TooManyApiKeys",
  { max: Schema.Number },
  { httpApiStatus: 409 },
) {}

/** `hash` is the SHA-256 of the secret; the secret itself never enters the model. */
export class ApiKeyIssued extends Domain.Event("ApiKeyIssued", {
  org: OrganizationId,
  key: Schema.String,
  name: Schema.String,
  prefix: Schema.String,
  hash: Schema.String,
}) {}

export class IssueApiKey extends Domain.Command("IssueApiKey", {
  target: ProjectId,
  middleware: [Caller],
  input: {
    project: ProjectId,
    /** The key's id: the browser generates the key (`makeApiKey`) and sends no secret. */
    key: Schema.String,
    name: Schema.String,
    prefix: Schema.String,
    /** SHA-256 hex of the whole token. */
    hash: Schema.String,
  },
  events: [ApiKeyIssued],
  rejects: [ProjectMissing, NotAllowed, TooManyApiKeys, TargetMismatch],
}) {}
