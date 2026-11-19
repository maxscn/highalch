import type * as Domain from "@alchemy.run/domain";
import { DbClient, type Transaction } from "@tanstack/db";
import {
  Cause,
  Effect,
  Clock,
  Context,
  Deferred,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { clientClosedMessage, Defect, type TaggedFailure } from "./state";
import type { Subscription } from "./feed";
import type { Subset } from "./subset";
import type { Answer, Input } from "./values";

/** The DbClient dependency under which the Domain connection is kept. */
export const dependency = "@highalch/db";

/** A schedule of retries for typed read failures, or defects reported by a read. */
export type Retry = Schedule.Schedule<unknown, TaggedFailure | Defect>;

export const transient: Retry = Schedule.exponential(250).pipe(
  Schedule.upTo({ times: 3 }),
  Schedule.while(({ input }: { input: TaggedFailure | Defect }) =>
    Predicate.isTagged(input, "RpcClientError"),
  ),
);

/** Time is provided by Clock. The story kit uses this reference to inspect its waits. */
export type Wait = "retry" | "reload" | "settle";
export const waitKind = Context.Reference<Wait>("HighAlch/Wait", { defaultValue: () => "retry" });

type Identifier<A extends Domain.Api.Any> = A["Client"]["Identifier"];

/** How a client behaves, besides how it reaches its Api. */
export type Settings = {
  /** The scope every feed of this client reads, e.g. the signed-in account's key. */
  readonly scope: string;
  /**
   * Follow each feed (default `true`). Server rendering sets `false`: subsets then load
   * on observation and explicit reload, and a command settles when it returns.
   */
  readonly live?: boolean;
  /** Retries of loads, reloads and feeds; defaults to `transient`. */
  readonly retry?: Retry;
  /** Milliseconds to wait for feed confirmation or, at close, an outstanding reply (default 10 000). */
  readonly settleTimeout?: number;
  /** Milliseconds a subset waits before reloading after a feed change or a reload call (default 50). */
  readonly reloadDelay?: number;
  /** Milliseconds an unobserved subset collection is kept (TanStack DB's `gcTime`). */
  readonly gcTime?: number;
  /** Time service for synchronous make. A scoped layer uses the ambient Clock by default. */
  readonly clock?: Clock.Clock;
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

type Runtime = {
  readonly endpoints: Effect.Effect<{
    readonly client: Endpoints;
    readonly context: Context.Context<never>;
  }>;
  readonly dispose: Effect.Effect<void>;
};

/** A failed Effect's typed error, or its whole cause as a `Defect`. */
export const failureOf = <E>(name: string, cause: Cause.Cause<E>): TaggedFailure | Defect => {
  const error = Cause.findErrorOption(cause);

  if (Option.isSome(error) && Predicate.hasProperty(error.value, "_tag"))
    // SAFETY: every typed error of a Domain endpoint is a tagged class instance.
    return error.value as TaggedFailure;

  return new Defect({ name, cause });
};

/** Preserve typed endpoint errors and translate defects at the reporting boundary. */
export const read = <A>(name: string, effect: Effect.Effect<A, TaggedFailure | Defect>) =>
  Effect.catchCause(effect, (cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);

    return Effect.fail(failureOf(name, cause));
  });

/** Brackets a detached endpoint so cancellation signals interruption without awaiting it. */
export const withEndpointFiber = <A, E, B, F>(
  endpoint: Effect.Effect<A, E>,
  use: (result: Effect.Effect<A, E>) => Effect.Effect<B, F>,
) =>
  Effect.acquireUseRelease(
    Effect.forkDetach(endpoint, { startImmediately: true, uninterruptible: false }),
    (fiber) => use(Fiber.join(fiber)),
    (fiber) => Effect.sync(() => fiber.interruptUnsafe()),
  );

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
  private readonly clock: Clock.Clock;
  private readonly endpointClock: Clock.Clock | undefined;
  private readonly scopeOfRun = Scope.makeUnsafe();
  private readonly commands = Effect.runSync(Scope.provide(FiberSet.make(), this.scopeOfRun));
  private readonly paced = new Set<Transaction>();
  private readonly replyDeadline = Deferred.makeUnsafe<void>();
  private closing: Effect.Effect<void> | undefined;
  /** One subscription per feed (stream name), shared by every subset of every entity on it. */
  readonly feeds = new Map<string, Subscription>();
  /** The subsets of each entity whose sync runs, by entity name. */
  readonly subsets = new Map<string, Set<Subset>>();

  constructor(
    settings: Settings,
    private readonly runtime: Runtime,
    ambientClock?: Clock.Clock,
  ) {
    this.scope = settings.scope;
    this.live = settings.live ?? true;
    this.retry = settings.retry ?? transient;
    this.settleTimeout = settings.settleTimeout ?? 10_000;
    this.reloadDelay = settings.reloadDelay ?? 50;
    this.gcTime = settings.gcTime;
    this.endpointClock = settings.clock;
    this.clock = settings.clock ?? ambientClock ?? Effect.runSync(Clock.Clock);
  }

  /** Starts an adapter worker from a synchronous TanStack callback. */
  fork = <A, E>(effect: Effect.Effect<A, E>, scope: Scope.Scope = this.scopeOfRun) =>
    Effect.runFork(effect.pipe(Effect.provideService(Clock.Clock, this.clock)), {
      onFiberStart: (fiber) => {
        Fiber.runIn(fiber, scope);
      },
    });

  openScope = () => Scope.forkUnsafe(this.scopeOfRun);

  /** Race the reply without making the transaction worker join an abandoned endpoint. */
  awaitReply = <A, E>(reply: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      if (Deferred.isDoneUnsafe(this.replyDeadline)) return Effect.succeed(Option.none());

      return withEndpointFiber(reply, (returned) =>
        Effect.raceFirst(
          Effect.asSome(returned),
          Effect.as(Deferred.await(this.replyDeadline), Option.none()),
        ),
      );
    });

  get closingOrClosed() {
    return this.closing !== undefined;
  }

  /** Keep a paced transaction cancellable until its strategy starts persistence. */
  trackPaced = (transaction: Transaction) => {
    if (this.paced.has(transaction)) return;

    this.paced.add(transaction);
    const release = () => this.paced.delete(transaction);

    void transaction.when("settled").then(release, release);
  };

  forkCommand = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runSync(
      FiberSet.run(this.commands, effect, { startImmediately: false }).pipe(
        Effect.provideService(Clock.Clock, this.clock),
      ),
    );

  /** TanStack mutation functions return promises. */
  runMutation = <A, E>(effect: Effect.Effect<A, E>, transaction: Transaction) => {
    this.paced.delete(transaction);
    if (this.closingOrClosed) return Promise.reject(closedClientError());

    const persisted = Deferred.makeUnsafe<A, E>();
    const published = Deferred.makeUnsafe<void>();
    const finish = () => {
      Deferred.doneUnsafe(published, Effect.void);
    };

    void transaction.when("settled").then(finish, finish);
    this.forkCommand(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(effect);

        Deferred.doneUnsafe(persisted, exit);
        yield* Deferred.await(published);
      }),
    );

    return Effect.runPromise(Deferred.await(persisted));
  };

  private contextOf(context: Context.Context<never>) {
    if (this.endpointClock) return Context.add(context, Clock.Clock, this.endpointClock);

    return context;
  }

  private endpoint<A>(call: (client: Endpoints) => Endpoint<A>): Endpoint<A> {
    return Effect.flatMap(this.runtime.endpoints, ({ client, context }) =>
      Effect.suspend(() => call(client)).pipe(Effect.provideContext(this.contextOf(context))),
    );
  }

  peek = (name: string, options?: Parameters<StreamEndpoints["peek"]>[1]) =>
    this.endpoint((client) => (client[name] as StreamEndpoints).peek(this.scope, options));

  events = (name: string, options: Parameters<StreamEndpoints["events"]>[1]) =>
    Stream.unwrap(
      Effect.map(this.runtime.endpoints, ({ client, context }) =>
        (client[name] as StreamEndpoints)
          .events(this.scope, options)
          .pipe(Stream.provideContext(this.contextOf(context))),
      ),
    );

  query = (name: string, ...args: Parameters<QueryEndpoint>) =>
    this.endpoint((client) => (client[name] as QueryEndpoint)(...args));

  command = (name: string, ...args: Parameters<CommandEndpoint>) =>
    this.endpoint((client) => (client[name] as CommandEndpoint)(...args));

  /** Registers a subset whose sync started; returns its release. */
  register = (entity: string, subset: Subset) => {
    const known = this.subsets.get(entity) ?? new Set<Subset>();

    known.add(subset);
    this.subsets.set(entity, known);

    return () => {
      known.delete(subset);

      if (known.size === 0 && this.subsets.get(entity) === known) this.subsets.delete(entity);
    };
  };

  /** The ready subsets of an entity. */
  ready = (entity: string): ReadonlyArray<Subset> => {
    const known = this.subsets.get(entity);

    if (!known) return [];

    return [...known].filter((subset) => subset.ready);
  };

  close = (db: DbClient) =>
    Effect.suspend(() => {
      this.closing ??= Effect.runSync(
        Effect.cached(
          this.drainCommands().pipe(
            Effect.andThen(Effect.promise(() => db.cleanup())),
            Effect.ensuring(Scope.close(this.scopeOfRun, Exit.void)),
            Effect.ensuring(this.runtime.dispose),
          ),
        ),
      );

      return this.closing;
    }).pipe(Effect.uninterruptible);

  private drainCommands() {
    const deadline = Effect.sleep(this.settleTimeout).pipe(
      Effect.andThen(Deferred.succeed(this.replyDeadline, undefined)),
      Effect.provideService(Clock.Clock, this.clock),
      Effect.provideService(waitKind, "settle"),
    );

    return Effect.gen({ self: this }, function* () {
      yield* Effect.forkScoped(deadline, { startImmediately: true, uninterruptible: false });

      for (const transaction of this.paced)
        if (transaction.state === "pending")
          transaction.rollback({ error: closedClientError(), isSecondaryRollback: true });

      this.paced.clear();
      yield* FiberSet.awaitEmpty(this.commands);
    }).pipe(Effect.scoped);
  }
}

export const closedClientError = () => new Error(clientClosedMessage);

/** The connection of a client made by `make`. */
export const connectionOf = (db: DbClient) => db.requireDependency<Connection>(dependency);

/** The runtime a config reaches its Api through. */
const runtimeOf = <A extends Domain.Api.Any>(config: Config<A>): Runtime => {
  const owned = !("runtime" in config);
  const runtime = "runtime" in config ? config.runtime : ManagedRuntime.make(config.layer);

  const endpoints = Effect.map(runtime.contextEffect, (context) => ({
    // SAFETY: an Api's Client key yields its endpoints by name.
    client: Context.get(context, config.api.Client) as Endpoints,
    context,
  }));

  if (owned) return { endpoints, dispose: runtime.disposeEffect };

  return { endpoints, dispose: Effect.void };
};

const makeClient = <A extends Domain.Api.Any>(config: Config<A>, ambientClock?: Clock.Clock) =>
  new DbClient({ [dependency]: new Connection(config, runtimeOf(config), ambientClock) });

/**
 * One account's TanStack `DbClient`, with its Domain connection as a dependency. Give it to the
 * `Provider` (or, on the server, make one per request). Its collections are materialised from
 * module-level declarations, so `dehydrate`/`hydrate` work with their ids.
 */
export const make = <A extends Domain.Api.Any>(config: Config<A>) => makeClient(config);

/**
 * Closes a client: waits until the commands it sent have settled (their transactions committed
 * or rolled back while their rows are still shown), then cleans up every collection and closes
 * the connection it built.
 */
export const close = (db: DbClient) => Effect.suspend(() => connectionOf(db).close(db));

/** The TanStack client supplied by layer. */
export class Client extends Context.Service<Client, DbClient>()("HighAlch/Client") {}

/** Makes a client for the lifetime of the layer. */
export const layer = <A extends Domain.Api.Any>(config: Config<A>) =>
  Layer.effect(
    Client,
    Effect.acquireRelease(
      Effect.map(Clock.Clock, (clock) => makeClient(config, clock)),
      close,
    ),
  );

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
