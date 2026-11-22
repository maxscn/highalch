import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ComparisonRecorded } from "./RecordComparison.command.ts";
import { RunDetail } from "./RunDetail.view.ts";
import { OrganizationRuns, RunListed } from "./OrganizationRuns.stream.ts";

/** Lists every completed (and compared) run on its organisation's stream. */
export class OrganizationRunIndex extends Domain.Projection("OrganizationRunIndex", {
  from: [RunDetail],
  key: OrganizationId,
  keyOf: { ComparisonRecorded: ({ event }) => event.org },
  on: [ComparisonRecorded],
  writes: [OrganizationRuns],
}) {}

export const OrganizationRunIndexLive = OrganizationRunIndex.toLayer(
  Effect.gen(function* () {
    const runs = yield* OrganizationRuns;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        const run = input.state;
        if (run === null || run._tag !== "Run") continue;
        yield* runs.append(
          input,
          new RunListed({
            run: input.source.id,
            project: run.project,
            commit: run.commit,
            branch: run.branch,
            pr: run.pr,
            source: run.source,
            kind: run.kind,
            createdAt: run.createdAt,
            completedAt: run.completedAt ?? DateTime.toEpochMillis(input.envelope.at),
            summary: run.summary,
            baseline: run.baseline,
          }),
        );
      }
    });
  }),
);
