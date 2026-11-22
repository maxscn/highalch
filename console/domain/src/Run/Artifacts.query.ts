import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Caller } from "../Caller.middleware.ts";
import { InvalidCursor } from "../InvalidCursor.rejection.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { nextOf, readableRun, seqOf } from "../Reads.ts";
import { ArtifactRow } from "./Artifact.rows.ts";
import { Run } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";
import { RunArtifacts } from "./RunArtifacts.stream.ts";
import { RunMissing } from "./RunMissing.rejection.ts";

/** The artifacts a run declared, in declaration order. */
export class Artifacts extends Domain.Query(
  "Artifacts",
  {
    input: { run: RunId },
    success: ArtifactRow,
    paged: true,
    middleware: [Caller],
    rejects: [NotAllowed, RunMissing, InvalidCursor],
  },
  { description: "The artifacts a run declared: name, type, size and digest." },
) {}

export const ArtifactsLive = Artifacts.toLayer(
  Effect.gen(function* () {
    const readable = readableRun(yield* Run);
    const artifacts = yield* RunArtifacts;
    return Effect.fn("Artifacts")(function* ({ run }, page) {
      yield* readable(run);
      const after = yield* seqOf(page.after);
      const listed = yield* artifacts.list(run, {
        take: page.take,
        ...(after === undefined ? {} : { after }),
      });
      return {
        // entry `n` of a run's stream is its artifact `<run>.<n>`
        entries: listed.entries.map(({ event, envelope }) => ({
          id: event.id,
          name: event.name,
          mime: event.mime,
          bytes: event.bytes,
          sha256: event.sha256,
          org: event.org,
          project: event.project,
          run,
          index: envelope.seq,
        })),
        cursor: nextOf(listed),
      };
    });
  }),
  { take: { default: 100, max: 500 } },
);
