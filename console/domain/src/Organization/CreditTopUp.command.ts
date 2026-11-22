import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { Count, Millis } from "../Ids.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationMissing } from "./OrganizationMissing.rejection.ts";

export class TopUpCredited extends Domain.Event("TopUpCredited", {
  topUp: Schema.String,
  /** The period it applies to (expires with it). */
  period: Millis,
  uploadedBytes: Count,
  artifacts: Count,
  resultRows: Count,
}) {}

/** A top-up payment succeeded (Stripe `checkout.session.completed` with `payment_status: paid`). */
export class CreditTopUp extends Domain.Command("CreditTopUp", {
  target: OrganizationId,
  middleware: [Caller],
  input: { topUp: Schema.String },
  events: [TopUpCredited],
  rejects: [OrganizationMissing, NotAllowed],
}) {}
