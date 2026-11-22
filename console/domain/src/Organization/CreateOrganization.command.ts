import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { UserId } from "../Ids.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { TargetMismatch } from "../TargetMismatch.rejection.ts";
import { OrganizationId } from "./Organization.id.ts";

export class OrganizationExists extends Domain.Rejection(
  "OrganizationExists",
  {},
  { httpApiStatus: 409 },
) {}

export class OrganizationCreated extends Domain.Event("OrganizationCreated", {
  name: Schema.String,
  owner: UserId,
  ownerEmail: Schema.String,
  ownerName: Schema.NullOr(Schema.String),
}) {}

/** A signed-in user creates an organisation and becomes its owner. It has no plan yet. */
export class CreateOrganization extends Domain.Command("CreateOrganization", {
  target: OrganizationId,
  middleware: [Caller],
  input: {
    org: OrganizationId,
    name: Schema.String,
    owner: UserId,
    ownerEmail: Schema.String,
    ownerName: Schema.NullOr(Schema.String),
  },
  events: [OrganizationCreated],
  rejects: [OrganizationExists, NotAllowed, TargetMismatch],
}) {}
