import type { Steps } from "./steps";

/**
 * Something that can happen to a story: a name, the values it is tried with, and the step each
 * value makes. `step(value)` makes the same step a story writes by hand, so a sequence of them
 * pastes as a story: `edit.step("locked")`. Adapters make sources (`Form.typing(form)`);
 * `@highalch/explore` declares others (`Explore.source`) and explores every sequence of them.
 */
export type Source<V = void> = {
  readonly name: string;
  readonly values: ReadonlyArray<V>;
  readonly step: (value: V) => Steps;
};

/** Any source, whatever its values: what an exploration's `sources` hold. */
export type AnySource = {
  readonly name: string;
  readonly values: ReadonlyArray<unknown>;
  readonly step: (value: never) => Steps;
};
