import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Caller } from "../Caller.middleware.ts";
import { InvalidCursor } from "../InvalidCursor.rejection.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { nextOf, readableRun, seqOf } from "../Reads.ts";
import { ResultRow } from "./Result.rows.ts";
import { Run } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";
import { RunMissing } from "./RunMissing.rejection.ts";
import { RunResults } from "./RunResults.stream.ts";

/** A run's stored results objects, in posting order: the index its result lists page through. */
export class ResultParts extends Domain.Query(
  "ResultParts",
  {
    input: { run: RunId },
    success: ResultRow,
    paged: true,
    middleware: [Caller],
    rejects: [NotAllowed, RunMissing, InvalidCursor],
  },
  { description: "Where a run's tests, fuzz cases, traces and snapshot map are stored." },
) {}

export const ResultPartsLive = ResultParts.toLayer(
  Effect.gen(function* () {
    const readable = readableRun(yield* Run);
    const results = yield* RunResults;
    return Effect.fn("ResultParts")(function* ({ run }, page) {
      yield* readable(run);
      const after = yield* seqOf(page.after);
      const listed = yield* results.list(run, {
        take: page.take,
        ...(after === undefined ? {} : { after }),
      });
      return {
        entries: listed.entries.map(({ event }) => ({
          key: event.key,
          run,
          org: event.org,
          project: event.project,
          part: event.part,
          count: event.count,
          charged: event.charged,
        })),
        cursor: nextOf(listed),
      };
    });
  }),
  { take: { default: 100, max: 500 } },
);
