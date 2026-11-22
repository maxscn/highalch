import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Blob } from "../Blob/Blob.aggregate.ts";
import { blobId } from "../Blob/Blob.id.ts";
import { ReferenceBlob } from "../Blob/ReferenceBlob.command.ts";
import { ArtifactsAccepted } from "../Organization/DeclareArtifacts.command.ts";
import {
  CloseRun,
  RunClosed,
  RunOpened,
  type RunContextStruct,
} from "../Organization/OpenRun.command.ts";
import { Organization } from "../Organization/Organization.aggregate.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ResultsAccepted } from "../Organization/RecordResults.command.ts";
import { ReleaseUsage } from "../Organization/ReleaseUsage.command.ts";
import { AddStory } from "../Story/AddStory.command.ts";
import { StoryAccepted } from "../Story/RecordStory.command.ts";
import { AddArtifacts } from "./AddArtifacts.command.ts";
import { AddResults } from "./AddResults.command.ts";
import { CreateRun } from "./CreateRun.command.ts";
import { FinishRun } from "./FinishRun.command.ts";
import { Run } from "./Run.aggregate.ts";
import type { RunId } from "./Run.id.ts";

/**
 * What an organisation accepted for one of its open runs reaches the run. Delivery order is not
 * relied on (a platform may run one key's deliveries out of order), so every step is safe in any
 * order:
 *
 * - each one first makes sure the run exists, from the context its event carries (one
 *   `CreateRun` per organisation and run, whichever step sends it first);
 * - artifacts are recorded once each body is referenced (reused when the organisation already
 *   stores it, else an upload of the blob's current generation); results and stories are
 *   recorded; these commute;
 * - completion carries how many uploads the organisation accepted, and the run completes only
 *   once it has applied them all;
 * - an upload the run cannot take (it expired first, or the id is another organisation's run)
 *   is never lost silently: its reservation is released and the drop recorded
 *   (`ReleaseUsage`, reason `dropped`). An id another organisation holds also frees the slot.
 *
 * Command ids derive from the accepting event, so a redelivery repeats nothing.
 */
export class RunIntake extends Domain.Policy("RunIntake", {
  from: Organization,
  on: [RunOpened, ArtifactsAccepted, ResultsAccepted, StoryAccepted, RunClosed],
}) {}

export const RunIntakeLive = RunIntake.toLayer(
  Effect.gen(function* () {
    const runs = yield* Run;
    const blobs = yield* Blob;
    const organizations = yield* Organization;

    /** Whether `run` is `org`'s, creating it first if no step did yet. */
    const ensure = (org: OrganizationId, run: RunId, context: RunContextStruct) =>
      Effect.map(
        runs.send(run, new CreateRun({ org, ...context }), { commandId: `create:${org}` }),
        (created) => created.reply.org === org,
      );

    return Effect.fn("RunIntake")(function* ({ source, event, envelope }) {
      const org = OrganizationId.make(source.id);
      const id = (step: string) => `intake:${envelope.stream}:${envelope.seq}:${step}`;

      /** Gives back what an upload the run could not take reserved, and records the drop. */
      const dropped = (
        run: RunId,
        usage: { readonly bytes: number; readonly artifacts: number; readonly rows: number },
        period: number | null,
      ) =>
        organizations.send(org, new ReleaseUsage({ run, ...usage, period, reason: "dropped" }), {
          commandId: id("dropped"),
        });

      switch (event._tag) {
        case "RunOpened": {
          const { _tag: _, run, period: __, ...context } = event;
          if (!(yield* ensure(org, run, context)))
            yield* organizations.send(org, new CloseRun({ run }), { commandId: id("close") });
          return;
        }
        case "ArtifactsAccepted": {
          const usage = {
            bytes: event.artifacts.reduce((n, a) => n + a.bytes, 0),
            artifacts: event.artifacts.length,
            rows: 0,
          };
          if (!(yield* ensure(org, event.run, event.context)))
            return yield* dropped(event.run, usage, event.period);
          const referenced = yield* Effect.forEach(
            event.artifacts,
            (artifact) =>
              Effect.map(
                blobs.send(
                  blobId(org, artifact.sha256),
                  new ReferenceBlob({ bytes: artifact.bytes }),
                  { commandId: id(`ref:${artifact.index}`) },
                ),
                ({ reply }) => ({
                  ...artifact,
                  upload: reply.upload,
                  generation: reply.generation,
                }),
              ),
            { concurrency: 1 },
          );
          const added = yield* runs.send(
            event.run,
            new AddArtifacts({ org, period: event.period, artifacts: referenced }),
            { commandId: id("artifacts") },
          );
          if (!added.reply.applied) yield* dropped(event.run, usage, event.period);
          return;
        }
        case "ResultsAccepted": {
          const usage = { bytes: event.bytes, artifacts: 0, rows: event.rows };
          if (!(yield* ensure(org, event.run, event.context)))
            return yield* dropped(event.run, usage, event.period);
          const added = yield* runs.send(
            event.run,
            new AddResults({
              org,
              period: event.period,
              parts: event.parts.map(({ part, key, count, charged }) => ({
                part,
                key,
                count,
                charged,
              })),
              uploads: event.parts.map(({ key, sha256, bytes }) => ({
                key,
                sha256,
                bytes,
                generation: null,
              })),
              tests: event.tests,
              cases: event.cases,
              traces: event.traces,
              bytes: event.bytes,
            }),
            { commandId: id("results") },
          );
          if (!added.reply.applied) yield* dropped(event.run, usage, event.period);
          return;
        }
        case "StoryAccepted": {
          const usage = { bytes: 0, artifacts: 0, rows: event.rows };
          if (!(yield* ensure(org, event.run, event.context)))
            return yield* dropped(event.run, usage, event.period);
          const added = yield* runs.send(
            event.run,
            new AddStory({ org, story: event.story, summary: event.summary }),
            { commandId: id("story") },
          );
          if (!added.reply.applied) yield* dropped(event.run, usage, event.period);
          return;
        }
        case "RunClosed":
          if (yield* ensure(org, event.run, event.context))
            yield* runs.send(event.run, new FinishRun({ org, writes: event.writes }), {
              commandId: id("finish"),
            });
          return;
      }
    });
  }),
);
