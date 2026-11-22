import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Blob } from "../Blob/Blob.aggregate.ts";
import { blobId, objectKey } from "../Blob/Blob.id.ts";
import { ForgetBlob } from "../Blob/ForgetBlob.command.ts";
import { OrganizationRuns } from "../Run/OrganizationRuns.stream.ts";
import { PurgeRun } from "../Run/PurgeRun.command.ts";
import { Run } from "../Run/Run.aggregate.ts";
import { RunId } from "../Run/Run.id.ts";
import { RunArtifacts } from "../Run/RunArtifacts.stream.ts";
import { RunDetail } from "../Run/RunDetail.view.ts";
import { RunResults } from "../Run/RunResults.stream.ts";
import { allEntries } from "../Run/SnapshotComparison.policy.ts";
import { Storage } from "../Storage.external.ts";
import { AdvanceRetention } from "./AdvanceRetention.command.ts";
import { Organization } from "./Organization.aggregate.ts";
import { ReleaseUsage } from "./ReleaseUsage.command.ts";
import { RetentionDue } from "./SweepRetention.command.ts";

/** Runs purged per pass at most; the next daily pass continues. */
export const runsPerPass = 200;

/**
 * Whenever retention is due: purge the organisation's completed runs older than its plan's
 * retention, oldest first. A run's results objects are deleted; each artifact body is
 * forgotten (and deleted) only if no newer run referenced it; its bytes go back to the
 * stored-bytes cap; the cursor moves past it. Every command is idempotent, so a redelivered
 * trigger repeats nothing.
 */
export class RetentionPurge extends Domain.Policy("RetentionPurge", {
  from: Organization,
  on: [RetentionDue],
}) {}

export const RetentionPurgeLive = RetentionPurge.toLayer(
  Effect.gen(function* () {
    const storage = yield* Storage;
    const listed = yield* OrganizationRuns;
    const results = yield* RunResults;
    const artifacts = yield* RunArtifacts;
    const details = yield* RunDetail;
    const blobs = yield* Blob;
    const runs = yield* Run;
    const organizations = yield* Organization;

    const purge = Effect.fn("RetentionPurge.run")(function* (
      org: string,
      run: RunId,
      cutoff: number,
    ) {
      const ref = Run.ref(run);
      // a consistency timeout is retried by redelivery
      const detail = yield* details.get(ref).pipe(Effect.orDie);
      if (detail._tag !== "Some" || detail.value._tag !== "Run" || detail.value.purged) return;
      const parts = yield* allEntries((after) =>
        results.list(run, { take: 200, ...(after === undefined ? {} : { after }) }),
      );
      if (parts.length > 0) yield* storage.remove({ keys: parts.map((p) => p.event.key) });
      const declared = yield* allEntries((after) =>
        artifacts.list(run, { take: 500, ...(after === undefined ? {} : { after }) }),
      );
      const bodies = [...new Set(declared.map((a) => a.event.sha256))];
      yield* Effect.forEach(
        bodies,
        (sha) =>
          Effect.gen(function* () {
            const forgotten = yield* blobs.send(
              blobId(org, sha),
              new ForgetBlob({ before: cutoff }),
            );
            if (forgotten.reply.forgotten)
              yield* storage.remove({ keys: [objectKey(org, sha, forgotten.reply.generation)] });
          }),
        { concurrency: 1 },
      );
      yield* organizations.send(
        detail.value.org,
        new ReleaseUsage({
          run,
          bytes: detail.value.bytes,
          artifacts: 0,
          rows: 0,
          period: null,
          reason: "retention",
        }),
      );
      yield* runs.send(ref, new PurgeRun({}));
    });

    return Effect.fn("RetentionPurge")(function* ({ source, event }) {
      const page = yield* listed.list(source.id, {
        order: "asc",
        take: runsPerPass,
        ...(event.after > 0 ? { after: event.after } : {}),
      });
      for (const entry of page.entries) {
        if (entry.event.completedAt >= event.cutoff) return;
        yield* purge(source.id, RunId.make(entry.event.run), event.cutoff);
        yield* organizations.send(source, new AdvanceRetention({ through: entry.envelope.seq }));
      }
    });
  }),
);
