import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Millis } from "../Ids.ts";
import { OrganizationId } from "./Organization.id.ts";

/** Runs completed before `cutoff`, after stream entry `after`, are past retention. */
export class RetentionDue extends Domain.Event("RetentionDue", {
  cutoff: Millis,
  after: Schema.Number,
}) {}

/** Daily deadline (re-armed by `RetentionSchedule`): start a retention pass. Never refused. */
export class SweepRetention extends Domain.Command("SweepRetention", {
  target: OrganizationId,
  input: {},
  events: [RetentionDue],
  rejects: [],
}) {}
