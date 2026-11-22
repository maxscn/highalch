import * as Domain from "@alchemy.run/domain";
import { Count, Millis } from "../Ids.ts";
import { RunId } from "../Run/Run.id.ts";

/**
 * Quota reserved before anything is accepted or any upload link is issued: declared artifact
 * bytes (deduplicated bodies included), results bytes and rows. One organisation decides, so
 * parallel reservations can never exceed a cap together.
 */
export class UsageReserved extends Domain.Event("UsageReserved", {
  run: RunId,
  period: Millis,
  bytes: Count,
  artifacts: Count,
  rows: Count,
}) {}
