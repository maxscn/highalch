import * as Domain from "@alchemy.run/domain";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mayUpload } from "../Actor.ts";
import { uploadUrlSeconds } from "../Billing/Plan.ts";
import { Blob } from "../Blob/Blob.aggregate.ts";
import { blobId, objectKey } from "../Blob/Blob.id.ts";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { Organization } from "../Organization/Organization.aggregate.ts";
import { allow } from "../Reads.ts";
import { Storage } from "../Storage.external.ts";
import { artifactsOf, resultsOf, SignedLink } from "./Links.ts";
import { RunId } from "./Run.id.ts";
import { RunArtifacts } from "./RunArtifacts.stream.ts";
import { RunIndex } from "./RunIndex.projection.ts";
import { RunNotOpen } from "./RunNotOpen.rejection.ts";
import { RunResults } from "./RunResults.stream.ts";
import { UnknownArtifact } from "./UnknownArtifact.rejection.ts";
import { UnknownResultPart } from "./UnknownResultPart.rejection.ts";

/**
 * Where CI uploads what its organisation accepted for an open run: a PUT link per artifact
 * whose body the organisation does not store yet (`null` when it does), and per results
 * object. Ask it at least at the receipt of the `DeclareArtifacts` / `RecordResults` that
 * accepted them (`atLeast`). Links bind size, digest and type and expire quickly; what does
 * not arrive intact is given back by verification.
 */
export class UploadLinks extends Domain.Query(
  "UploadLinks",
  {
    input: {
      run: RunId,
      artifacts: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
      results: Schema.Array(Schema.String).check(Schema.isMaxLength(3)),
    },
    success: Schema.Struct({
      artifacts: Schema.Array(Schema.Struct({ id: Schema.String, link: SignedLink })),
      results: Schema.Array(Schema.Struct({ key: Schema.String, link: SignedLink })),
    }),
    waitsFor: [RunIndex],
    middleware: [Caller],
    rejects: [NotAllowed, RunNotOpen, UnknownArtifact, UnknownResultPart],
  },
  { description: "Signed PUT links for a run's accepted artifacts and results objects." },
) {}

export const UploadLinksLive = UploadLinks.toLayer(
  Effect.gen(function* () {
    const storage = yield* Storage;
    const blobs = yield* Blob;
    const organizations = yield* Organization;
    const artifactIndex = yield* RunArtifacts;
    const resultIndex = yield* RunResults;
    return Effect.fn("UploadLinks")(function* ({ run, artifacts, results }) {
      const declared = yield* artifactsOf(artifactIndex, run);
      const stored = yield* resultsOf(resultIndex, run);
      const owners = [
        ...artifacts.map((id) => declared.get(id) ?? new UnknownArtifact({ artifact: id })),
        ...results.map((key) => stored.get(key) ?? new UnknownResultPart({ key })),
      ];
      for (const owner of owners)
        if (owner._tag === "UnknownArtifact" || owner._tag === "UnknownResultPart")
          return yield* owner;
      const actor = yield* CurrentActor;
      for (const owner of owners)
        if (owner._tag === "ArtifactListed" || owner._tag === "ResultPartListed")
          yield* allow(mayUpload(actor, owner.org, owner.project, run));
      const first = owners[0];
      if (
        first !== undefined &&
        (first._tag === "ArtifactListed" || first._tag === "ResultPartListed")
      ) {
        const org = yield* organizations.get(first.org);
        if (org._tag !== "Active" || !org.openRuns.some((open) => open.run === run))
          return yield* new RunNotOpen();
      }
      const expiresAt = (yield* Clock.currentTimeMillis) + uploadUrlSeconds * 1000;
      const put = (key: string, mime: string, bytes: number, sha256: string) =>
        Effect.map(
          storage.presignPut({ key, mime, bytes, sha256, seconds: uploadUrlSeconds }),
          ({ url, headers }): SignedLink => ({ url, headers, expiresAt }),
        );
      const artifactLinks = yield* Effect.forEach(artifacts, (id) =>
        Effect.gen(function* () {
          const artifact = declared.get(id);
          if (artifact === undefined) return { id, link: null };
          const blob = yield* blobs.get(blobId(artifact.org, artifact.sha256));
          if (blob.status === "stored" && blob.bytes === artifact.bytes) return { id, link: null };
          const key = objectKey(artifact.org, artifact.sha256, blob.generation);
          return { id, link: yield* put(key, artifact.mime, artifact.bytes, artifact.sha256) };
        }),
      );
      const resultLinks = yield* Effect.forEach(results, (key) =>
        Effect.gen(function* () {
          const part = stored.get(key);
          if (part === undefined || part.sha256 === null || part.bytes === null)
            return { key, link: null };
          return { key, link: yield* put(key, "application/json", part.bytes, part.sha256) };
        }),
      );
      return { artifacts: artifactLinks, results: resultLinks };
    });
  }),
);
