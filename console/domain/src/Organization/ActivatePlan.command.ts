import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { Millis } from "../Ids.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationMissing } from "./OrganizationMissing.rejection.ts";

export class PlanActivated extends Domain.Event("PlanActivated", {
  plan: Schema.String,
  periodStart: Millis,
  periodEnd: Millis,
  /** A payment-failure suspension is lifted by the paid invoice; others stay. */
  liftsSuspension: Schema.Boolean,
}) {}

/**
 * A subscription invoice was paid (Stripe `invoice.paid`): the plan is active until
 * `periodEnd`. Only trusted server code (the verified webhook) sends it, with the Stripe event
 * id as command id, so a replay is a no-op. An older period than the current one changes nothing.
 */
export class ActivatePlan extends Domain.Command("ActivatePlan", {
  target: OrganizationId,
  middleware: [Caller],
  input: { plan: Schema.String, periodStart: Millis, periodEnd: Millis },
  events: [PlanActivated],
  rejects: [OrganizationMissing, NotAllowed],
}) {}
