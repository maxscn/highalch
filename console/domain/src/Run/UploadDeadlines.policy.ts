import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { uploadUrlSeconds } from "../Billing/Plan.ts";
import { objectKey } from "../Blob/Blob.id.ts";
import { ResultsRecorded } from "./AddResults.command.ts";
import { ArtifactsDeclared } from "./AddArtifacts.command.ts";
import { CheckUploads } from "./CheckUploads.command.ts";
import { Run } from "./Run.aggregate.ts";

/**
 * Once a batch's upload links have expired (plus slack), verify what was uploaded: each body
 * the organisation did not already store, and each results object.
 */
export class UploadDeadlines extends Domain.Policy("UploadDeadlines", {
  from: Run,
  on: [ArtifactsDeclared, ResultsRecorded],
}) {}

export const UploadDeadlinesLive = UploadDeadlines.toLayer(
  Effect.gen(function* () {
    const runs = yield* Run;
    return Effect.fn(function* ({ source, event, envelope }) {
      const uploads =
        event._tag === "ResultsRecorded"
          ? event.uploads
          : event.artifacts
              .filter((a) => a.upload)
              .map((a) => ({
                key: objectKey(event.org, a.sha256, a.generation),
                sha256: a.sha256,
                bytes: a.bytes,
                generation: a.generation,
              }));
      if (uploads.length === 0) return;
      yield* runs.schedule(source, new CheckUploads({ period: event.period, uploads }), {
        after: `${uploadUrlSeconds + 60} seconds`,
        commandId: `check:${envelope.stream}:${envelope.seq}`,
      });
    });
  }),
);
