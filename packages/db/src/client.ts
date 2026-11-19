import type * as Domain from "@alchemy.run/domain";
import { DbClient } from "@tanstack/db";
import {
  Cause,
  Effect,
  ManagedRuntime,
  Option,
  Predicate,
  type Exit,
  type Layer,
  type Stream,
} from "effect";
import { Defect, type TaggedFailure } from "./state";
import type { Subscription } from "./feed";
import type { Subset } from "./subset";
import type { Answer, Input } from "./values";

/** The DbClient dependency under which the Domain connection is kept. */
export const dependency = "@highalch/db";

/**
 * Whether, and after how many milliseconds, to try a failed load or feed again: `attempt` is the
 * attempt that failed (1 for the first). `Option.none()` stops: a load before its first readiness
 * then fails with `error`, a feed (or a reload) after it stops its live updates.
 */
export type Retry = (error: TaggedFailure | Defect, attempt: number) => Option.Option<number>;

/** Transport failures are retried three times, after 250, 500 and 1000 ms; nothing else is. */
export const transient: Retry = (error, attempt) => {
  if (attempt > 3 || !Predicate.isTagged(error, "RpcClientError")) return Option.none();

  return Option.some(250 * 2 ** (attempt - 1));
};

/** Why a client waits: a retry's delay, a subset's reload debounce, or a command's settle timeout. */
export type Wait = "retry" | "reload" | "settle";

/**
 * Where a client's waits are scheduled: `set` runs `run` after `ms` milliseconds and returns its
 * cancel. The default is the global `setTimeout`; a test (the story kit) passes a clock it
 * controls. Every timer a client starts goes through it, so production behaviour is unchanged.
 */
export type Timers = {
  readonly set: (run: () => void, ms: number, wait: Wait) => () => void;
};

/** The global `setTimeout`. */
export const realTimers: Timers = {
  set: (run, ms) => {
    const timer = setTimeout(run, ms);

    return () => clearTimeout(timer);
  },
};

type Identifier<A extends Domain.Api.Any> = A["Client"]["Identifier"];

/** How a client behaves, besides how it reaches its Api. */
export type Settings = {
  /** The scope every feed of this client reads, e.g. the signed-in account's key. */
  readonly scope: string;
  /**
   * Follow each feed (default `true`). Server rendering sets `false`: subsets then load
   * once, and a command settles when it returns.
   */
  readonly live?: boolean;
  /** Retries of loads, reloads and feeds; defaults to `transient`. */
  readonly retry?: Retry;
  /** Milliseconds a command waits for the feed to deliver its change (default 10 000). */
  readonly settleTimeout?: number;
  /** Milliseconds a subset waits before reloading for rows it cannot place (default 50). */
  readonly reloadDelay?: number;
  /** Milliseconds an unobserved subset collection is kept (TanStack DB's `gcTime`). */
  readonly gcTime?: number;
  /** Where retries, reload debounces and settle timeouts wait (default: `setTimeout`). */
  readonly timers?: Timers;
};

/**
 * A client of the Api `api`, reached through its client Layer (`Api.layerClientWebSocket(url)`,
 * with its middleware clients provided; the connection builds and disposes it) or a runtime that
 * already holds the client (its owner disposes it).
 */
export type Config<A extends Domain.Api.Any> = Settings & { readonly api: A } & (
    | { readonly layer: Layer.Layer<Identifier<A>> }
    | { readonly runtime: ManagedRuntime.ManagedRuntime<Identifier<A>, never> }
  );

/** A Domain read or write endpoint of the Api client, as this package calls it. */
type Endpoint<A> = Effect.Effect<A, TaggedFailure>;

/** One entry a feed delivers: an appended event with its envelope. */
export type Entry = {
  readonly event: Answer;
  readonly envelope: { readonly seq: number; readonly commandId: string };
};

export type Frame = Domain.Read.CaughtUp | Entry;

export type Receipt = {
  readonly reply: Answer | undefined;
  readonly stream: string;
  readonly version: number;
};

/** The reads of a served stream this package uses: its latest entry, and its entries after a cursor. */
type StreamEndpoints = {
  readonly peek: (
    key: string,
    options?: { readonly atLeast?: { readonly stream: string; readonly version: number } },
  ) => Endpoint<Entry | null>;
  readonly events: (
    key: string,
    options: { readonly after: number },
  ) => Stream.Stream<Frame, TaggedFailure>;
};

/** A stream's cursor: the `seq` of its latest entry, `0` before any. */
export const cursorOf = (latest: Entry | null) =>
  Option.match(Option.fromNullishOr(latest), {
    onNone: () => 0,
    onSome: (entry) => entry.envelope.seq,
  });

type QueryEndpoint = (
  input: Input,
  options: { readonly after?: string; readonly take?: number },
) => Endpoint<Answer | null>;

type CommandEndpoint = (
  target: string,
  input: Input,
  options: { readonly commandId: string },
) => Endpoint<Receipt>;

/** The Api client: its streams, queries and commands by name. */
type Endpoints = {
  readonly [name: string]: StreamEndpoints | QueryEndpoint | CommandEndpoint;
};

/** What the connection runs on: the Api client, a way to run its Effects, and disposal. */
type Runtime = {
  readonly client: () => Promise<Endpoints>;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<Exit.Exit<A, E>>;
  readonly dispose: () => Promise<void>;
};

/** A failed Effect's typed error, or its whole cause as a `Defect`. */
export const failureOf = <E>(name: string, cause: Cause.Cause<E>): TaggedFailure | Defect => {
  const error = Cause.findErrorOption(cause);

  if (Option.isSome(error) && Predicate.hasProperty(error.value, "_tag"))
    // SAFETY: every typed error of a Domain endpoint is a tagged class instance.
    return error.value as TaggedFailure;

  return new Defect({ name, cause });
};

/**
 * One account's connection to a Domain: the Api client, one subscription per feed and the subset
 * collections materialised from module-level declarations. It lives in its `DbClient`.
 */
export class Connection {
  readonly scope: string;
  readonly live: boolean;
  readonly retry: Retry;
  readonly settleTimeout: number;
  readonly reloadDelay: number;
  readonly gcTime: number | undefined;
  readonly timers: Timers;
  /** One subscription per feed (stream name), shared by every subset of every entity on it. */
  readonly feeds = new Map<string, Subscription>();
  /** The subsets of each entity whose sync runs, by entity name. */
  readonly subsets = new Map<string, Set<Subset>>();
  private endpoints: Promise<Endpoints> | undefined;
  /** Commands sent and not yet settled (committed, unconfirmed or rolled back). */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    settings: Settings,
    private readonly runtime: Runtime,
  ) {
    this.scope = settings.scope;
    this.live = settings.live ?? true;
    this.retry = settings.retry ?? transient;
    this.settleTimeout = settings.settleTimeout ?? 10_000;
    this.reloadDelay = settings.reloadDelay ?? 50;
    this.gcTime = settings.gcTime;
    this.timers = settings.timers ?? realTimers;
  }

  /** Runs `run` after `ms` through the client's timers; returns its cancel. */
  after = (ms: number, wait: Wait, run: () => void) => this.timers.set(run, ms, wait);

  /** Resolves after `ms` through the client's timers. */
  sleep = (ms: number, wait: Wait) =>
    new Promise<void>((resolve) => {
      this.timers.set(resolve, ms, wait);
    });

  private resolve() {
    this.endpoints ??= this.runtime.client();

    return this.endpoints;
  }

  /** The `peek` and `events` endpoints of a served stream. */
  stream = async (name: string) => {
    const client = await this.resolve();

    // SAFETY: the Api client serves each stream under its name with these reads.
    return client[name] as StreamEndpoints;
  };

  /** The method of a served query. */
  query = async (name: string) => {
    const client = await this.resolve();

    // SAFETY: the Api client serves each query as a method under its name.
    return client[name] as QueryEndpoint;
  };

  /** The method of a served command. */
  command = async (name: string) => {
    const client = await this.resolve();

    // SAFETY: the Api client serves each command as a method under its tag.
    return client[name] as CommandEndpoint;
  };

  /** Runs an Effect of the Api client to its exit. */
  run = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => this.runtime.run(effect);

  /** Registers a subset whose sync started; returns its release. */
  register = (entity: string, subset: Subset) => {
    const known = this.subsets.get(entity) ?? new Set<Subset>();

    known.add(subset);
    this.subsets.set(entity, known);

    return () => {
      known.delete(subset);

      if (known.size === 0) this.subsets.delete(entity);
    };
  };

  /** The ready subsets of an entity. */
  ready = (entity: string): ReadonlyArray<Subset> => {
    const known = this.subsets.get(entity);

    if (!known) return [];

    return [...known].filter((subset) => subset.ready);
  };

  /** Keeps a command's settlement until it ends, so closing waits for it; answers it. */
  track = <A>(settlement: Promise<A>): Promise<A> => {
    this.pending.add(settlement);

    const done = () => void this.pending.delete(settlement);

    settlement.then(done, done);

    return settlement;
  };

  /** Resolves once every command sent so far (and any sent meanwhile) has settled. */
  settled = async () => {
    while (this.pending.size > 0) await Promise.allSettled(this.pending);
  };

  /** Disposes the runtime this connection built (a runtime it was given stays open). */
  dispose = () => this.runtime.dispose();
}

/** The connection of a client made by `make`. */
export const connectionOf = (db: DbClient) => db.requireDependency<Connection>(dependency);

/** The runtime a config reaches its Api through. */
const runtimeOf = <A extends Domain.Api.Any>(config: Config<A>): Runtime => {
  const owned = !("runtime" in config);
  const runtime = "runtime" in config ? config.runtime : ManagedRuntime.make(config.layer);

  return {
    client: () =>
      runtime.runPromise(
        Effect.map(
          config.api.Client,
          // SAFETY: an Api's `Client` key yields its client, its endpoints by name.
          (client) => client as Endpoints,
        ),
      ),
    run: (effect) => runtime.runPromiseExit(effect),
    dispose: async () => {
      if (owned) await runtime.dispose();
    },
  };
};

/**
 * One account's TanStack `DbClient`, with its Domain connection as a dependency. Give it to the
 * `Provider` (or, on the server, make one per request). Its collections are materialised from
 * module-level declarations, so `dehydrate`/`hydrate` work with their ids.
 */
export const make = <A extends Domain.Api.Any>(config: Config<A>) =>
  new DbClient({ [dependency]: new Connection(config, runtimeOf(config)) });

/**
 * Closes a client: waits until the commands it sent have settled (their transactions committed
 * or rolled back while their rows are still shown), then cleans up every collection and closes
 * the connection it built.
 */
export const close = async (db: DbClient) => {
  const connection = connectionOf(db);

  await connection.settled();
  await db.cleanup();
  await connection.dispose();
};

/**
 * Reloads every loaded subset of an entity in a client, for a change its feed does not carry: a
 * write through another path than the entity's commands. Subsets replace their rows in one sync
 * transaction (no flicker); calls within the client's `reloadDelay` reload once.
 */
export const reload = (db: DbClient, entity: { readonly entityName: string }) => {
  for (const subset of connectionOf(db).ready(entity.entityName)) subset.schedule();
};

const active: Array<DbClient> = [];

/** Makes a client the one commands use when they are given none; returns the release. */
export const activate = (db: DbClient) => {
  active.push(db);

  return () => {
    const index = active.indexOf(db);

    if (index >= 0) active.splice(index, 1);
  };
};

/**
 * The client a command uses when it is given none: the one `Provider` registered. Fails loudly
 * when there is none (a call during server rendering, or outside the provider) or when two
 * different clients are mounted (pass one with `command.with({ client })`).
 */
export const current = (): DbClient => {
  const distinct = [...new Set(active)];

  if (distinct.length === 1 && distinct[0]) return distinct[0];

  if (distinct.length === 0)
    throw new Error(
      "No HighAlch client is active: render HighAlch's Provider, or pass a client with command.with({ client })",
    );

  throw new Error(
    "Several HighAlch clients are active: pass the one to use with command.with({ client })",
  );
};
