/**
 * Stories for data synced with `@highalch/db` and the machines over it: given server
 * history, when a client (or another one, or the world, or a machine) acts, then what each source
 * shows, in which read state, how each command settled and where each machine is. One runner
 * (`make`) runs every kind of step in any order: a hosted story hosts the consumer's Domain in
 * memory behind a wire it controls, with real `HighAlch` clients on a clock it controls; a hostless
 * story (`make()`) only steps machines purely. Machine steps come from
 * `@highalch/story/xstate`; this entry never imports XState. Test-runner agnostic: a story
 * is a promise to await inside your own test.
 *
 * ```ts
 * import * as Story from "@highalch/story";
 * ```
 */
export { memory } from "./host";

export type { ClientOf, Host, Hosting, Memory, SessionOf } from "./host";

export { make, StoryFailure } from "./run";

export type { Story as Runner, StoryOptions, StepReport } from "./run";

export {
  advance,
  alchemy,
  as,
  check,
  drop,
  fail,
  flatten,
  given,
  historyOf,
  hold,
  idle,
  mute,
  open,
  rejected,
  release,
  recover,
  reload,
  remote,
  resume,
  settle,
  settled,
  shows,
  staged,
  state,
  step,
  when,
  Mismatch,
} from "./steps";

export type { Stage } from "./stage";

export type { Acting, Callable, Expected, ReadState, ShownRow, Step, Steps } from "./steps";

export {
  invariants,
  noFlickerBack,
  nothingPending,
  rejectedRestores,
  subsetsAgree,
} from "./invariants";

export type { Invariant, Moment } from "./invariants";

export { transport, Wire } from "./wire";

export { json, plain, retryTransport, World, Observed } from "./world";

export type { Client, Entry, Observation, Options, Outcome, Run, Shown, Source } from "./world";

export { Live, Settled, view } from "./view";

export type { ViewResult, ViewState } from "./view";
