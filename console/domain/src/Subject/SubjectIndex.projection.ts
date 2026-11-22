import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { ProjectId } from "../Project/Project.id.ts";
import { ComparisonRecorded } from "../Run/RecordComparison.command.ts";
import { Run } from "../Run/Run.aggregate.ts";
import { subjectId } from "./Subject.ts";
import { SubjectResultListed, SubjectResults } from "./SubjectResults.stream.ts";

/** Appends each compared run's per-subject results to its project's history. */
export class SubjectIndex extends Domain.Projection("SubjectIndex", {
  from: [Run],
  key: ProjectId,
  keyOf: { ComparisonRecorded: ({ event }) => event.project },
  on: [ComparisonRecorded],
  writes: [SubjectResults],
}) {}

export const SubjectIndexLive = SubjectIndex.toLayer(
  Effect.gen(function* () {
    const results = yield* SubjectResults;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        const e = input.event;
        if (e.subjects.length === 0) continue;
        yield* results.append(
          input,
          ...e.subjects.map(
            (tally) =>
              new SubjectResultListed({
                org: e.org,
                project: e.project,
                subject: subjectId(e.project, tally.kind, tally.name),
                kind: tally.kind,
                name: tally.name,
                run: input.source.id,
                commit: e.commit,
                branch: e.branch,
                pr: e.pr,
                completedAt: e.completedAt,
                items: tally.items,
                failures: tally.failures,
                snapshots: tally.snapshots,
                schemaHash: tally.schemaHash,
              }),
          ),
        );
      }
    });
  }),
);
