import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Count, Millis } from "../Ids.ts";
import { RunId } from "../Run/Run.id.ts";
import { OrganizationId } from "./Organization.id.ts";

/**
 * Why usage is given back: an upload that never arrived intact (`unverified`), data deleted by
 * retention (`retention`), or a write the organisation accepted that its run could not take
 * (`dropped`: the run expired first, or the id is another organisation's run).
 */
export const ReleaseReason = Schema.Literals(["unverified", "retention", "dropped"]);
export type ReleaseReason = typeof ReleaseReason.Type;

export class UsageReleased extends Domain.Event("UsageReleased", {
  run: RunId,
  bytes: Count,
  artifacts: Count,
  rows: Count,
  /** Also refunded to this period's upload allowance (only while it is current). */
  period: Schema.NullOr(Millis),
  reason: ReleaseReason,
}) {}

/**
 * Give back reserved usage: bytes (and the period's allowance when `period` is set), artifacts
 * and result rows. A dropped write is recorded even when it reserved nothing (a story).
 * Sent by trusted server code and policies; never refused.
 */
export class ReleaseUsage extends Domain.Command("ReleaseUsage", {
  target: OrganizationId,
  input: {
    run: RunId,
    bytes: Count,
    artifacts: Count,
    rows: Count,
    period: Schema.NullOr(Millis),
    reason: ReleaseReason,
  },
  events: [UsageReleased],
  rejects: [],
}) {}
