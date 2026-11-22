import { Context, type Option } from "effect";
import type { Input } from "./values";

/** How a command ended, as the data layer records it: `Committed`, `Rejected` (`error`), … */
export type CommandOutcome = {
  readonly _tag: string;
  readonly error?: unknown;
  readonly cause?: unknown;
  /** The value it settled with (an `Option`), when it has one. */
  readonly value?: unknown;
};

/** A command the data layer ran and recorded. */
export type CommandRun = {
  readonly label: string;
  /** Who ran it: the story itself, or a machine (`machine:editor`). */
  readonly by: string;
  /** The world's tick when it ran. */
  readonly tick: number;
  readonly input: Input;
  /** The declared command it called, when there is one. */
  readonly command: Option.Option<unknown>;
  /** How it ended, once `done`. */
  readonly outcome: CommandOutcome;
  readonly done: Promise<void>;
};

/** A command to run for its owner: on the client of `scope`, recorded under `label` and `by`. */
export type CommandRequest = {
  readonly label: string;
  readonly scope: string;
  readonly by: string;
  readonly input: Input;
  readonly command: Option.Option<unknown>;
  /** Calls the command on the scope's client, reporting the value it settled with. */
  readonly call: (client: unknown, onCommitted: (value: unknown) => void) => unknown;
};

/**
 * The story's data layer, as screens and machines use it without knowing which one it is: a
 * mounted view goes under the client of its scope (`mount`), a running machine's commands run on
 * it and are recorded (`run`, `runs`). A host
 * provides it through its `adapters` (`Db.data` from `@highalch/tanstack-db`; `Alchemy.memory`
 * includes it).
 */
export interface DataLayer {
  /** The client of `scope`, connected (the step's scope by default). */
  readonly connect: (scope?: string) => Promise<void>;
  /** `element` under the provider its client is read from (a React element, for screens). */
  readonly mount: (element: unknown, scope?: string) => Promise<unknown>;
  readonly run: (request: CommandRequest) => Promise<CommandRun>;
  /** Every command run so far, in order. */
  readonly runs: () => ReadonlyArray<CommandRun>;
}

/** The story's data layer, as a service a host's `adapters` provide. */
export class Data extends Context.Service<Data, DataLayer>()("@highalch/story/Data") {}
