import * as Schema from "effect/Schema";
import { findPlan, type Limits } from "../Billing/Plan.ts";
import { Count, Millis } from "../Ids.ts";

export const SuspensionReason = Schema.Literals(["payment_failed", "refunded", "disputed"]);
export type SuspensionReason = typeof SuspensionReason.Type;

/** What the organisation has paid for. `periodEnd` comes from Stripe; past it, access lapses. */
export const Entitlement = Schema.Struct({
  plan: Schema.NullOr(Schema.String),
  periodStart: Schema.NullOr(Millis),
  periodEnd: Schema.NullOr(Millis),
  suspended: Schema.NullOr(SuspensionReason),
  customer: Schema.NullOr(Schema.String),
});
export type Entitlement = typeof Entitlement.Type;

/** Usage of one paid period (`period` is its `periodStart`); top-ups of that period. */
export const PeriodUsage = Schema.Struct({
  period: Millis,
  uploadedBytes: Count,
  artifacts: Count,
  resultRows: Count,
  runs: Count,
  topUpBytes: Count,
  topUpArtifacts: Count,
  topUpRows: Count,
});
export type PeriodUsage = typeof PeriodUsage.Type;

export const emptyUsage = (period: number): PeriodUsage => ({
  period,
  uploadedBytes: 0,
  artifacts: 0,
  resultRows: 0,
  runs: 0,
  topUpBytes: 0,
  topUpArtifacts: 0,
  topUpRows: 0,
});

/** The usage of the current period: counters of an older period read as zero. */
export const currentUsage = (entitlement: Entitlement, usage: PeriodUsage): PeriodUsage =>
  entitlement.periodStart !== null && usage.period === entitlement.periodStart
    ? usage
    : emptyUsage(entitlement.periodStart ?? 0);

export type Access =
  | { readonly _tag: "Active"; readonly limits: Limits }
  | { readonly _tag: "Denied"; readonly reason: "no_entitlement" | "suspended" };

/** What decides access: the plan, its paid period and any suspension. */
export type Paid = Pick<Entitlement, "plan" | "periodEnd" | "suspended">;

/** Fails closed: no plan, an unknown plan, a past period or a suspension all deny. */
export const access = (entitlement: Paid, now: number): Access => {
  if (entitlement.suspended !== null) return { _tag: "Denied", reason: "suspended" };
  const plan = entitlement.plan === null ? undefined : findPlan(entitlement.plan);
  if (!plan || entitlement.periodEnd === null || entitlement.periodEnd <= now)
    return { _tag: "Denied", reason: "no_entitlement" };
  return { _tag: "Active", limits: plan.limits };
};

/** Limits of the current period including its top-ups. */
export const effectiveLimits = (limits: Limits, usage: PeriodUsage): Limits => ({
  ...limits,
  uploadedBytesPerPeriod: limits.uploadedBytesPerPeriod + usage.topUpBytes,
  artifactsPerPeriod: limits.artifactsPerPeriod + usage.topUpArtifacts,
  resultRowsPerPeriod: limits.resultRowsPerPeriod + usage.topUpRows,
});

/** A plan's limits as rows carry them (`Billing/Plan.ts` holds the table). */
export const LimitsRow = Schema.Struct({
  storedBytes: Count,
  uploadedBytesPerPeriod: Count,
  artifactsPerPeriod: Count,
  resultRowsPerPeriod: Count,
  runsPerPeriod: Count,
  maxArtifactBytes: Count,
  retentionDays: Count,
  requestsPerMinute: Count,
  activeRuns: Count,
});

/**
 * - `none`: never paid.
 * - `active`: a paid period is current.
 * - `lapsed`: the period ended without a paid renewal.
 * - `suspended`: a payment failed, was refunded or disputed.
 */
export type BillingStatus = "none" | "active" | "lapsed" | "suspended";

/** An entitlement's status at `now` (it lapses by time alone, so readers compute it). */
export const billingStatus = (entitlement: Paid, now: number): BillingStatus => {
  if (entitlement.suspended !== null) return "suspended";
  if (entitlement.plan === null || entitlement.periodEnd === null) return "none";
  return access(entitlement, now)._tag === "Active" ? "active" : "lapsed";
};
