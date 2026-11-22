import * as Domain from "@alchemy.run/domain";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { downloadUrlSeconds } from "../Billing/Plan.ts";
import { Blob } from "../Blob/Blob.aggregate.ts";
import { blobId, objectKey } from "../Blob/Blob.id.ts";
import { Caller } from "../Caller.middleware.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { readableRun } from "../Reads.ts";
import { Storage } from "../Storage.external.ts";
import { artifactsOf, SignedLink } from "./Links.ts";
import { Run } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";
import { RunArtifacts } from "./RunArtifacts.stream.ts";
import { RunMissing } from "./RunMissing.rejection.ts";
import { UnknownArtifact } from "./UnknownArtifact.rejection.ts";

/**
 * Short-lived GET links to a run's artifacts (attachments, frames, traces, story reports), for
 * whoever may read the run. `null` for a body that is not stored (yet) or a purged run.
 */
export class ArtifactLinks extends Domain.Query(
  "ArtifactLinks",
  {
    input: { run: RunId, ids: Schema.Array(Schema.String).check(Schema.isMaxLength(100)) },
    success: Schema.Array(Schema.Struct({ id: Schema.String, link: SignedLink })),
    middleware: [Caller],
    rejects: [NotAllowed, RunMissing, UnknownArtifact],
  },
  { description: "Signed GET links to a run's artifacts." },
) {}

export const ArtifactLinksLive = ArtifactLinks.toLayer(
  Effect.gen(function* () {
    const readable = readableRun(yield* Run);
    const storage = yield* Storage;
    const blobs = yield* Blob;
    const index = yield* RunArtifacts;
    return Effect.fn("ArtifactLinks")(function* ({ run, ids }) {
      const state = yield* readable(run);
      const declared = yield* artifactsOf(index, run);
      const unknown = ids.find((id) => !declared.has(id));
      if (unknown !== undefined) return yield* new UnknownArtifact({ artifact: unknown });
      const expiresAt = (yield* Clock.currentTimeMillis) + downloadUrlSeconds * 1000;
      return yield* Effect.forEach(ids, (id) =>
        Effect.gen(function* () {
          const artifact = declared.get(id);
          if (artifact === undefined || state.purged) return { id, link: null };
          const blob = yield* blobs.get(blobId(artifact.org, artifact.sha256));
          if (blob.status !== "stored") return { id, link: null };
          const { url } = yield* storage.presignGet({
            key: objectKey(artifact.org, artifact.sha256, blob.generation),
            mime: artifact.mime,
            name: artifact.name,
            seconds: downloadUrlSeconds,
          });
          return { id, link: { url, headers: {}, expiresAt } };
        }),
      );
    });
  }),
);
