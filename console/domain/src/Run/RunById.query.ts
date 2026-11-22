import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mayRead } from "../Actor.ts";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { allow } from "../Reads.ts";
import { Run } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";
import { RunRow, runRow } from "./Run.rows.ts";

/** One run, or `null` when it does not exist. */
export class RunById extends Domain.Query(
  "RunById",
  {
    input: { run: RunId },
    success: Schema.NullOr(RunRow),
    middleware: [Caller],
    rejects: [NotAllowed],
  },
  { description: "A run's commit, branch, PR, status, summary and baseline." },
) {}

export const RunByIdLive = RunById.toLayer(
  Effect.gen(function* () {
    const runs = yield* Run;
    return Effect.fn("RunById")(function* ({ run }) {
      const state = yield* runs.get(run);
      if (state._tag !== "Run") return null;
      yield* allow(mayRead(yield* CurrentActor, state.org, state.project));
      return runRow(run, state);
    });
  }),
);
