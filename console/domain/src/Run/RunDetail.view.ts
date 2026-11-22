import * as Domain from "@alchemy.run/domain";
import { Run, RunState } from "./Run.aggregate.ts";

type Fold = (s: RunState, e: unknown, envelope: unknown) => RunState;
const folds = Run.definition.evolve as unknown as Record<string, Fold>;

/** A run's state after each of its events: the source of its run rows and of `RunIndex`. */
export class RunDetail extends Domain.View(
  "RunDetail",
  {
    from: [Run],
    key: Run,
    state: RunState,
    initial: { _tag: "Unborn" },
    evolve: {
      Run: (state, event, { envelope }) => folds[event._tag]?.(state, event, envelope) ?? state,
    },
  },
  { description: "A run's commit, branch, PR, status and summary." },
) {}
