import * as Domain from "@alchemy.run/domain";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { downloadUrlSeconds } from "../Billing/Plan.ts";
import { Caller } from "../Caller.middleware.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { readableRun } from "../Reads.ts";
import { Storage } from "../Storage.external.ts";
import { resultsOf, SignedLink } from "./Links.ts";
import { Run } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";
import { RunMissing } from "./RunMissing.rejection.ts";
import { RunResults } from "./RunResults.stream.ts";
import { UnknownResultPart } from "./UnknownResultPart.rejection.ts";

/**
 * Short-lived GET links to a run's results objects (JSON arrays of tests, fuzz cases or traces,
 * the snapshot map), for whoever may read the run; the browser fetches the items from storage.
 * `null` for a purged run.
 */
export class ResultPartLinks extends Domain.Query(
  "ResultPartLinks",
  {
    input: { run: RunId, keys: Schema.Array(Schema.String).check(Schema.isMaxLength(50)) },
    success: Schema.Array(Schema.Struct({ key: Schema.String, link: SignedLink })),
    middleware: [Caller],
    rejects: [NotAllowed, RunMissing, UnknownResultPart],
  },
  { description: "Signed GET links to a run's stored results objects." },
) {}

export const ResultPartLinksLive = ResultPartLinks.toLayer(
  Effect.gen(function* () {
    const readable = readableRun(yield* Run);
    const storage = yield* Storage;
    const index = yield* RunResults;
    return Effect.fn("ResultPartLinks")(function* ({ run, keys }) {
      const state = yield* readable(run);
      const stored = yield* resultsOf(index, run);
      const unknown = keys.find((key) => !stored.has(key));
      if (unknown !== undefined) return yield* new UnknownResultPart({ key: unknown });
      const expiresAt = (yield* Clock.currentTimeMillis) + downloadUrlSeconds * 1000;
      return yield* Effect.forEach(keys, (key) =>
        Effect.gen(function* () {
          if (state.purged) return { key, link: null };
          const { url } = yield* storage.presignGet({
            key,
            mime: "application/json",
            name: null,
            seconds: downloadUrlSeconds,
          });
          return { key, link: { url, headers: {}, expiresAt } };
        }),
      );
    });
  }),
);
