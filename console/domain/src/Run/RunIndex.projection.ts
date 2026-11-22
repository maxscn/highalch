import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { ArtifactsAccepted } from "../Organization/DeclareArtifacts.command.ts";
import { Organization } from "../Organization/Organization.aggregate.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ResultsAccepted } from "../Organization/RecordResults.command.ts";
import { ComparisonRecorded } from "./RecordComparison.command.ts";
import { Run } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";
import { ArtifactListed, RunArtifacts } from "./RunArtifacts.stream.ts";
import { ResultPartListed, RunResults } from "./RunResults.stream.ts";

/**
 * Lists each artifact and results object of a run as soon as its organisation accepts it (so a
 * link query read at the accepting command's receipt finds it), and the objects its snapshot
 * comparison wrote.
 */
export class RunIndex extends Domain.Projection("RunIndex", {
  from: [Organization, Run],
  key: RunId,
  keyOf: {
    ArtifactsAccepted: ({ event }) => event.run,
    ResultsAccepted: ({ event }) => event.run,
    ComparisonRecorded: ({ source }) => source.id,
  },
  on: [ArtifactsAccepted, ResultsAccepted, ComparisonRecorded],
  writes: [RunArtifacts, RunResults],
}) {}

export const RunIndexLive = RunIndex.toLayer(
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    const results = yield* RunResults;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        const event = input.event;
        switch (event._tag) {
          case "ArtifactsAccepted":
            yield* artifacts.append(
              input,
              ...event.artifacts.map(
                (a) =>
                  new ArtifactListed({
                    org: OrganizationId.make(input.source.id),
                    project: event.project,
                    id: a.id,
                    name: a.name,
                    mime: a.mime,
                    bytes: a.bytes,
                    sha256: a.sha256,
                  }),
              ),
            );
            break;
          case "ResultsAccepted":
            if (event.parts.length > 0)
              yield* results.append(
                input,
                ...event.parts.map(
                  (p) =>
                    new ResultPartListed({
                      org: OrganizationId.make(input.source.id),
                      project: event.project,
                      part: p.part,
                      key: p.key,
                      count: p.count,
                      charged: p.charged,
                      sha256: p.sha256,
                      bytes: p.bytes,
                    }),
                ),
              );
            break;
          case "ComparisonRecorded":
            if (event.parts.length > 0)
              yield* results.append(
                input,
                ...event.parts.map(
                  (p) =>
                    new ResultPartListed({
                      org: event.org,
                      project: event.project,
                      ...p,
                      sha256: null,
                      bytes: null,
                    }),
                ),
              );
            break;
        }
      }
    });
  }),
);
