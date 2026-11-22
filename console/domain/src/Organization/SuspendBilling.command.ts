import * as Domain from "@alchemy.run/domain";
import { Caller } from "../Caller.middleware.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { SuspensionReason } from "./Billing.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationMissing } from "./OrganizationMissing.rejection.ts";

export class BillingSuspended extends Domain.Event("BillingSuspended", {
  reason: SuspensionReason,
}) {}

export class BillingResumed extends Domain.Event("BillingResumed", {
  reason: SuspensionReason,
}) {}

/** A renewal failed, a charge was refunded or disputed: uploads stop at once. */
export class SuspendBilling extends Domain.Command("SuspendBilling", {
  target: OrganizationId,
  middleware: [Caller],
  input: { reason: SuspensionReason },
  events: [BillingSuspended],
  rejects: [OrganizationMissing, NotAllowed],
}) {}

/** A dispute was won: lifts a suspension for exactly that reason. */
export class ResumeBilling extends Domain.Command("ResumeBilling", {
  target: OrganizationId,
  middleware: [Caller],
  input: { reason: SuspensionReason },
  events: [BillingResumed],
  rejects: [OrganizationMissing, NotAllowed],
}) {}
