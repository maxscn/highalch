import type { Stage } from "./stage";

/** When an invariant is checked: after a step, or at the end of the story (`final`). */
export type Moment = { readonly final: boolean };

/**
 * A property every state of a story must have. `check` reads the story run (its world, and the
 * adapters' state through `stage.use(adapter)`) and answers the violations it found (empty when it
 * holds); stories run with invariants check them after every step and at the end.
 */
export type Invariant = {
  readonly name: string;
  readonly check: (stage: Stage, moment: Moment) => Promise<ReadonlyArray<string>>;
};
