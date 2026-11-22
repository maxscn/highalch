import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Blob } from "../Blob/Blob.aggregate.ts";
import { blobId } from "../Blob/Blob.id.ts";
import { ConfirmBlob } from "../Blob/ConfirmBlob.command.ts";
import { Organization } from "../Organization/Organization.aggregate.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ReleaseUsage } from "../Organization/ReleaseUsage.command.ts";
import { Storage } from "../Storage.external.ts";
import { UploadCheckDue } from "./CheckUploads.command.ts";
import { ForfeitUpload } from "./ForfeitUpload.command.ts";
import { Run } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";

/**
 * Verifies each upload of a batch against storage (mismatched objects are deleted there),
 * records a body's outcome on its blob, and gives back the quota of what did not arrive
 * intact: its bytes, and for bodies their artifact allowance.
 */
export class UploadVerification extends Domain.Policy("UploadVerification", {
  from: Run,
  on: [UploadCheckDue],
}) {}

export const UploadVerificationLive = UploadVerification.toLayer(
  Effect.gen(function* () {
    const storage = yield* Storage;
    const blobs = yield* Blob;
    const organizations = yield* Organization;
    const runs = yield* Run;
    return Effect.fn("UploadVerification")(function* ({ source, event }) {
      const outcomes = yield* Effect.forEach(
        event.uploads,
        (upload) =>
          Effect.gen(function* () {
            const { status } = yield* storage.inspect({
              key: upload.key,
              bytes: upload.bytes,
              sha256: upload.sha256,
            });
            if (upload.generation !== null)
              yield* blobs.send(
                blobId(event.org, upload.sha256),
                new ConfirmBlob({ generation: upload.generation, ok: status === "ok" }),
              );
            return { ok: status === "ok", body: upload.generation !== null, bytes: upload.bytes };
          }),
        { concurrency: 1 },
      );
      const lost = outcomes.filter((outcome) => !outcome.ok);
      if (lost.length === 0) return;
      const bytes = lost.reduce((n, outcome) => n + outcome.bytes, 0);
      yield* runs.send(source, new ForfeitUpload({ bytes }));
      yield* organizations.send(
        OrganizationId.make(event.org),
        new ReleaseUsage({
          run: RunId.make(source.id),
          bytes,
          artifacts: lost.filter((outcome) => outcome.body).length,
          rows: 0,
          period: event.period,
          reason: "unverified",
        }),
      );
    });
  }),
);
