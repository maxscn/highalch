/**
 * Stories for data synced with `@lowalch/tanstack-db` and the machines over it: given server
 * history, when a client (or another one, or the world, or a machine) acts, then what each source
 * shows, in which read state, how each command settled and where each machine is. One runner
 * (`make`) runs every kind of step in any order: a hosted story hosts the consumer's Domain in
 * memory behind a wire it controls, with real `LowAlch` clients on a clock it controls; a hostless
 * story (`make()`) only steps machines purely. This entry holds the runner and the Domain's
 * steps (`given`, `remote`, the transport's faults, time); TanStack DB steps come from
 * `@highalch/story/tanstack-db` (`Db`), machine steps from `@highalch/story/xstate` (`Machine`)
 * and screen steps from `@highalch/story/screen` (`Screen`). This entry never imports XState.
 * Test-runner agnostic: a story is a promise to await inside your own test.
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
  hold,
  idle,
  mute,
  release,
  recover,
  remote,
  resume,
  settle,
  staged,
  step,
  Mismatch,
} from "./steps";

export { CurrentStage } from "./stage";

export type { Adapter, Done, Stage } from "./stage";

export { registryOf as registry } from "./atoms";

export type { Step, Steps } from "./steps";

export { Explore, ExploreFailure } from "./explore";

export type { Exploration, Explored, Source as ExploreSource } from "./explore";

export { reader } from "./rules";

export type {
  Ask,
  At,
  Holds,
  Moment,
  Reader,
  Rule,
  Settings as RuleSettings,
  StepOf,
  Yieldable,
} from "./rules";

export { transport, Wire } from "./wire";

export { json, macrotask, World } from "./world";

export type { Field, Options, Plain } from "./world";
