import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Millis } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { RunId } from "./Run.id.ts";
import { PendingUpload } from "./Run.values.ts";

/** The upload links of a batch have expired: time to verify what arrived. */
export class UploadCheckDue extends Domain.Event("UploadCheckDue", {
  org: OrganizationId,
  period: Millis,
  uploads: Schema.Array(PendingUpload),
}) {}

/** Scheduled by `UploadDeadlines` once a batch's upload links can no longer be used. */
export class CheckUploads extends Domain.Command("CheckUploads", {
  target: RunId,
  input: { period: Millis, uploads: Schema.Array(PendingUpload) },
  events: [UploadCheckDue],
  rejects: [],
}) {}
