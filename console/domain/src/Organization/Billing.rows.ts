import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Schema from "effect/Schema";
import { findPlan } from "../Billing/Plan.ts";
import { Count, Millis } from "../Ids.ts";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { currentUsage, effectiveLimits, LimitsRow, SuspensionReason } from "./Billing.ts";
import type { ActiveOrganization } from "./Organization.aggregate.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationOverview } from "./OrganizationOverview.view.ts";

/**
 * An organisation's plan, period, limits (with this period's top-ups) and usage. Its status
 * depends on the time it is read at: `billingStatus(row, now)`.
 */
export const BillingRow = Schema.Struct({
  org: OrganizationId,
  plan: Schema.NullOr(Schema.String),
  periodStart: Schema.NullOr(Millis),
  periodEnd: Schema.NullOr(Millis),
  suspended: Schema.NullOr(SuspensionReason),
  /** Whether a Stripe customer exists (the billing portal needs one). */
  customer: Schema.Boolean,
  limits: Schema.NullOr(LimitsRow),
  usage: Schema.Struct({
    storedBytes: Count,
    uploadedBytes: Count,
    artifacts: Count,
    resultRows: Count,
    runs: Count,
    activeRuns: Count,
  }),
  /** Uploads accepted that their run could not take: their usage was given back. */
  droppedWrites: Count,
});
export type BillingRow = typeof BillingRow.Type;

/** The billing row of an organisation's state. */
export const billingRow = (org: OrganizationId, o: ActiveOrganization): BillingRow => {
  const usage = currentUsage(o.entitlement, o.usage);
  const plan = o.entitlement.plan === null ? undefined : findPlan(o.entitlement.plan);
  return {
    org,
    plan: o.entitlement.plan,
    periodStart: o.entitlement.periodStart,
    periodEnd: o.entitlement.periodEnd,
    suspended: o.entitlement.suspended,
    customer: o.entitlement.customer !== null,
    limits: plan === undefined ? null : effectiveLimits(plan.limits, usage),
    usage: {
      storedBytes: o.storedBytes,
      uploadedBytes: usage.uploadedBytes,
      artifacts: usage.artifacts,
      resultRows: usage.resultRows,
      runs: usage.runs,
      activeRuns: o.openRuns.length,
    },
    droppedWrites: o.droppedWrites,
  };
};

/** Retention bookkeeping changes no billing row. */
const quiet = new Set(["RetentionDue", "RetentionAdvanced"]);

/** An organisation's billing and usage, after every change of either. */
export class BillingRows extends HighAlch.Rows("BillingRows", {
  feed: OrganizationChanges,
  row: BillingRow,
  key: "org",
  from: [OrganizationOverview],
  scope: ({ source }) => source.id,
  on: {
    OrganizationOverview: (event, { source, state }) =>
      state?._tag === "Active" && !quiet.has(event._tag)
        ? HighAlch.upserted(billingRow(source.id, state))
        : undefined,
  },
}) {}
