import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { RunContextStruct } from "./OpenRun.command.ts";
import { Caller } from "../Caller.middleware.ts";
import { Millis } from "../Ids.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { RunId } from "../Run/Run.id.ts";
import { RunNotOpen } from "../Run/RunNotOpen.rejection.ts";
import { AcceptedArtifact, ArtifactUpload } from "../Run/Run.values.ts";
import { TargetMismatch } from "../TargetMismatch.rejection.ts";
import { NotEntitled } from "./NotEntitled.rejection.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationMissing } from "./OrganizationMissing.rejection.ts";
import { QuotaExceeded } from "./QuotaExceeded.rejection.ts";
import { UsageReserved } from "./UsageReserved.event.ts";

/** Most artifacts one declaration may hold. */
export const maxArtifactsPerBatch = 100;

/** Artifacts of an open run were accepted (their quota reserved), with their ids. */
export class ArtifactsAccepted extends Domain.Event("ArtifactsAccepted", {
  run: RunId,
  project: ProjectId,
  period: Millis,
  artifacts: Schema.Array(AcceptedArtifact),
  /** The run's context, so the run can be created from any of its writes. */
  context: RunContextStruct,
}) {}

/**
 * CI declares bodies it is about to upload: their quota is reserved and each gets an id
 * (`<run>.<n>`, in order). Upload links come from the `UploadLinks` query, read at least at this
 * command's receipt; a body the organisation already stores needs none.
 */
export class DeclareArtifacts extends Domain.Command("DeclareArtifacts", {
  target: OrganizationId,
  middleware: [Caller],
  input: {
    org: OrganizationId,
    run: RunId,
    artifacts: Schema.Array(ArtifactUpload).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(maxArtifactsPerBatch),
    ),
  },
  events: [UsageReserved, ArtifactsAccepted],
  rejects: [
    OrganizationMissing,
    NotAllowed,
    NotEntitled,
    QuotaExceeded,
    RunNotOpen,
    TargetMismatch,
  ],
  reply: { ids: Schema.Array(Schema.String) },
}) {}
