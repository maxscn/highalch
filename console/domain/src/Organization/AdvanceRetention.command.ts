import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { OrganizationId } from "./Organization.id.ts";

export class RetentionAdvanced extends Domain.Event("RetentionAdvanced", {
  /** Every `OrganizationRuns` entry up to this sequence number has been purged. */
  through: Schema.Number,
}) {}

/** The retention job purged completed runs up to `through`. */
export class AdvanceRetention extends Domain.Command("AdvanceRetention", {
  target: OrganizationId,
  input: { through: Schema.Number },
  events: [RetentionAdvanced],
  rejects: [],
}) {}
