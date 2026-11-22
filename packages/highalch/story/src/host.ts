import type { Context, Layer } from "effect";
import type { CurrentStage } from "./stage";

/**
 * Where a story's backend runs. `client(scope)` is the client a reader of `scope` uses: a record of
 * its endpoints (calls answering an Effect, and streams: `peek` and `events`), which the story
 * wraps in the wire of that scope. The rest is optional:
 *
 * - `queries`: the endpoints whose answers a wire holds (it lets command replies flow);
 * - `caughtUp`: whether a stream's frame says the stream caught up (what a muted wire lets through);
 * - `idle`: whether the backend has nothing queued;
 * - `service`: a service of the host, for `check`;
 * - `adapters`: Layers the story's adapters are built with, given the story's stage: how its
 *   clients connect, and its data layer (`Data`) for screens and machines.
 *
 * `@highalch/alchemy-domain` hosts an alchemy Domain in memory (`Alchemy.memory`); `local()` hosts
 * nothing, for clients that sync nothing.
 */
export type Host<C = unknown> = {
  readonly client: (scope: string) => Promise<C>;
  readonly queries?: ReadonlyArray<string>;
  readonly caughtUp?: (frame: unknown) => boolean;
  readonly idle?: () => Promise<boolean>;
  readonly service?: <I, S>(key: Context.Key<I, S>) => Promise<S>;
  readonly adapters?: ReadonlyArray<Layer.Layer<never, never, CurrentStage>>;
  readonly dispose: () => Promise<void>;
};

/** Builds a fresh host for each story. */
export type Hosting<C = unknown> = () => Promise<Host<C>>;

/**
 * A host with nothing behind it: for clients that sync nothing (local-only collections), so
 * their steps still run in a world with a clock and wires. `adapters` give it a data layer for
 * screens and machines: `Story.local({ adapters: [Db.data] })`.
 */
export const local =
  (
    options: { readonly adapters?: ReadonlyArray<Layer.Layer<never, never, CurrentStage>> } = {},
  ): Hosting<Readonly<Record<string, never>>> =>
  async () => ({
    client: async () => ({}),
    ...(options.adapters !== undefined && { adapters: options.adapters }),
    dispose: async () => {},
  });
