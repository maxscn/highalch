/**
 * Stories for frontends: given a state, when something happens, then what the app shows and what
 * it asked for. One runner (`make`) runs every kind of step in any order, in a world it controls:
 * a host behind a wire (faults, held replies, muted streams) and a clock (`advance`). Adapters add
 * the steps and the host: `Db` (`@highalch/tanstack-db`), `Machine` (`@highalch/xstate`), `Screen`
 * (`@highalch/screen`), `Form` (`@highalch/tanstack-form`), and an alchemy Domain hosted in memory
 * (`Alchemy`, `@highalch/alchemy-domain`). `local()` hosts nothing, for clients that sync nothing;
 * a hostless story (`make()`) only steps machines purely. Rules (`rule`) are checked at their
 * moments. Test-runner agnostic: a story is a promise to await inside your own test.
 *
 * ```ts
 * import * as Story from "@highalch/story";
 * ```
 */
export { Data } from "./data";

export type { CommandOutcome, CommandRequest, CommandRun, DataLayer } from "./data";

export { local } from "./host";

export type { Host, Hosting } from "./host";

export { make, StoryFailure } from "./run";

export type { Observed, Observer, Story as Runner, StoryOptions, StepReport } from "./run";

export {
  advance,
  as,
  check,
  drop,
  fail,
  flatten,
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

export type { Adapter, Done, Shown, Stage } from "./stage";

export { registryOf as registry } from "./atoms";

export type { Step, Steps } from "./steps";

export type { AnySource, Source } from "./sources";

export { before, reader, rule } from "./rules";

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
