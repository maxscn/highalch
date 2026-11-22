import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationMissing } from "./OrganizationMissing.rejection.ts";

export class CustomerLinked extends Domain.Event("CustomerLinked", { customer: Schema.String }) {}

/** Records the organisation's Stripe customer (created server-side before the first checkout). */
export class LinkCustomer extends Domain.Command("LinkCustomer", {
  target: OrganizationId,
  middleware: [Caller],
  input: { customer: Schema.String },
  events: [CustomerLinked],
  rejects: [OrganizationMissing, NotAllowed],
}) {}
