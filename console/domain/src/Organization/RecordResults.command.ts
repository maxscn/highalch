import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { RunContextStruct } from "./OpenRun.command.ts";
import { Caller } from "../Caller.middleware.ts";
import { Count, Millis } from "../Ids.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { RunId } from "../Run/Run.id.ts";
import { RunNotOpen } from "../Run/RunNotOpen.rejection.ts";
import {
  CaseCounts,
  Kind,
  ResultPart,
  ResultUpload,
  TestCounts,
  TraceCounts,
} from "../Run/Run.values.ts";
import { TargetMismatch } from "../TargetMismatch.rejection.ts";
import { NotEntitled } from "./NotEntitled.rejection.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationMissing } from "./OrganizationMissing.rejection.ts";
import { QuotaExceeded } from "./QuotaExceeded.rejection.ts";
import { UsageReserved } from "./UsageReserved.event.ts";

/** Largest results object CI may upload, bytes. */
export const maxPartBytes = 1_000_000;

export class KindMismatch extends Domain.Rejection(
  "KindMismatch",
  { expected: Kind },
  { httpApiStatus: 422 },
) {}

/** A results batch of an open run was accepted (quota reserved); its objects' keys are derived. */
export class ResultsAccepted extends Domain.Event("ResultsAccepted", {
  run: RunId,
  project: ProjectId,
  period: Millis,
  kind: Kind,
  parts: Schema.Array(Schema.Struct({ ...ResultPart.fields, sha256: Schema.String, bytes: Count })),
  tests: TestCounts,
  cases: CaseCounts,
  traces: TraceCounts,
  bytes: Count,
  /** The rows reserved for the batch. */
  rows: Count,
  /** The run's context, so the run can be created from any of its writes. */
  context: RunContextStruct,
}) {}

/**
 * CI records a results batch: one JSON object per part (tests, fuzz cases, traces), each
 * uploaded through its `UploadLinks` link to the key the reply names, and the batch's counts.
 * Quota is reserved for the bytes and the charged rows: per object its reported items, but at
 * least what its bytes can hold (`chargedRows`), and at least `minRowsPerBatch` per batch. Items
 * are never in the model; server-side processing reads at most an object's charged rows. An
 * object that does not arrive intact is given back by verification; a reported count that
 * turns out wrong gives nothing back.
 */
export class RecordResults extends Domain.Command("RecordResults", {
  target: OrganizationId,
  middleware: [Caller],
  input: {
    org: OrganizationId,
    run: RunId,
    kind: Kind,
    parts: Schema.Array(
      Schema.Struct({
        ...ResultUpload.fields,
        bytes: Count.check(Schema.isLessThanOrEqualTo(maxPartBytes)),
      }),
    ).check(Schema.isMaxLength(3)),
    tests: TestCounts,
    cases: CaseCounts,
    traces: TraceCounts,
  },
  events: [UsageReserved, ResultsAccepted],
  rejects: [
    OrganizationMissing,
    NotAllowed,
    NotEntitled,
    QuotaExceeded,
    RunNotOpen,
    KindMismatch,
    TargetMismatch,
  ],
  reply: { keys: Schema.Array(Schema.String) },
}) {}
