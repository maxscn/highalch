import type { CollectionOptions, DbClient, NonSingleResult, Transaction } from "@tanstack/db";
import { Cause, Context, Data, Effect, Exit, Layer, Option, Predicate } from "effect";
import { CurrentStage, Mismatch } from "@highalch/story/internal";
import type { Answer, Input, Tagged } from "@highalch/story/internal";
import type { Sent, Watcher, Wire } from "@highalch/story/internal";
import { json, macrotask, type Plain, type World } from "@highalch/story/internal";
import {
  Connect,
  plain as plainConnector,
  type Change,
  type Connector,
  type Watched,
} from "./connector";

/** A row a collection shows: its fields, and whether a local transaction is pending on it. */
export type Shown = { readonly row: Plain; readonly pending: boolean };

/** One change a story observed in a collection: the row of `key` after it (`None`: it left). */
export type Observation = {
  /** The world's observation counter when it happened. */
  readonly tick: number;
  /** The step that was running. */
  readonly step: number;
  readonly key: string;
  readonly shown: Option.Option<Shown>;
};

/** Removes TanStack DB's virtual fields. */
export const plain = (row: object): Plain =>
  Object.fromEntries(Object.entries(row).filter(([name]) => !name.startsWith("$")));

/** A source a consumer passes to `useLiveQuery`: a collection descriptor. */
// `any` utils: a source of any collection kind (local-only, query, a LowAlch subset) fits. The
// utils type is invariant, so no narrower type accepts them all; steps never read a source's utils.
// oxlint-disable-next-line typescript/no-explicit-any
export type Source<Row extends object = object> = CollectionOptions<Row, string, never, any> &
  NonSingleResult;

/** The row type of a source. */
export type RowOf<S> = S extends Source<infer Row> ? Row : never;

/**
 * One source a story's client materialised and keeps observed, as a mounted `useLiveQuery`
 * would: its rows now (with their pending flag) and every change it showed.
 */
export class Observed {
  readonly rows = new Map<string, Shown>();
  readonly history: Array<Observation> = [];
  /** Whether a step has opened or read it: until then the world has not settled since it opened. */
  awaited = false;
  private readonly subscription: { readonly unsubscribe: () => void };

  constructor(
    readonly clients: Clients,
    readonly scope: string,
    readonly label: string,
    readonly collection: Watched,
  ) {
    const world = clients.world;

    this.subscription = collection.subscribeChanges(
      (changes) => {
        // A batch renders once: each key's last change in it is what a live query showed (a
        // reload replaces a row as a delete and an insert in one batch).
        const last = new Map<string, Change>();

        for (const change of changes) {
          last.delete(String(change.key));
          last.set(String(change.key), change);
        }

        for (const [key, change] of last) {
          const shown = Option.liftPredicate(
            { row: plain(change.value), pending: change.value.$hasPendingWrites === true },
            () => change.type !== "delete",
          );

          if (Option.isSome(shown)) this.rows.set(key, shown.value);
          else this.rows.delete(key);

          this.history.push({ tick: world.next(), step: world.step, key, shown });
        }
      },
      { includeInitialState: true },
    );
  }

  get id() {
    return this.collection.id;
  }

  /** The rows now, by key. */
  sorted = () => [...this.rows].sort(([a], [b]) => a.localeCompare(b));

  /**
   * The source's read state as the app's views read a live query over it (the connector's
   * reading): `Loading`, `Ready`, `Missing` (with `single`), or another tagged state or error.
   */
  state = (single = false): Tagged => this.clients.connector.state(this.collection, single);

  close = () => this.subscription.unsubscribe();
}

/**
 * How a command of a story ended: still `Pending`; `Committed` (the value the call reported when
 * it settled, if any) or `Unconfirmed` (a value tagged so); `Rejected` with its typed error; or
 * `Died` with a defect.
 */
export type Outcome = Data.TaggedEnum<{
  Pending: {};
  Committed: { readonly value: Option.Option<Settled> };
  Unconfirmed: { readonly value: Settled };
  Rejected: { readonly error: Tagged };
  Died: { readonly cause: Cause.Cause<never> };
}>;

export const Outcome = Data.taggedEnum<Outcome>();

/** What a call reports when it settles (`Committed`, `Unconfirmed`, …): a tagged value. */
export type Settled = Tagged;

/** What a command replies, as a story holds it. */
export type Reply = Answer | void;

/** A declared command, as a story holds it (to compare it with what a machine ran). */
export interface Declared {}

/** A command one of the story's clients ran (a `when` step, or one a machine invoked). */
export type Run = {
  readonly label: string;
  readonly scope: string;
  /** What ran it: the story itself or a machine. */
  readonly by: string;
  /** The key of the row it addresses (empty for a command with no rows). */
  readonly key: string;
  /** The id it was sent with: the Domain's `commandId`, which the feed's entries name. */
  readonly commandId: string;
  /** Its transaction, when the story started it (a command the app sent itself has none here). */
  readonly transaction: Option.Option<Transaction>;
  /** The command it called, when a step or machine called a declared command. */
  readonly command: Option.Option<Declared>;
  readonly input: Input;
  readonly tick: number;
  readonly step: number;
  /** What every observed source of its client showed for each key just before it ran. */
  readonly before: ReadonlyMap<string, ReadonlyMap<string, Shown>>;
  outcome: Outcome;
  /** The tick it ended at. */
  ended: number;
  readonly done: Promise<void>;
};

/** One client of a story: a scope's `DbClient`, its wire, and the sources it observes. */
export type Client = {
  readonly scope: string;
  readonly db: DbClient;
  readonly wire: Wire;
  readonly observed: Map<string, Observed>;
  /** Who records the commands the app sends itself through this client's wire. */
  readonly watcher: Watcher;
};

/**
 * The TanStack DB clients of one story run (one per scope, made by the run's connector), the
 * sources they observe, and the commands they ran. Data steps, machines and screens act on it;
 * `Db.check` steps and rules read it.
 */
export class Clients {
  readonly runs: Array<Run> = [];
  private readonly clients = new Map<string, Client>();
  /** Releases of clients `activate`d by steps, run when the story ends. */
  readonly releases: Array<() => void> = [];

  constructor(
    readonly world: World,
    readonly connector: Connector,
  ) {}

  /** Opens the client of `scope`. */
  connect = async (scope = this.world.scope): Promise<Client> => {
    const known = this.clients.get(scope);

    if (known) return known;

    const db = await this.connector.connect(scope);
    const wire = this.world.wire(scope);
    const watcher = this.watcher(scope);
    const client = { scope, db, wire, observed: new Map<string, Observed>(), watcher };

    this.clients.set(scope, client);
    wire.watchers.push(watcher);

    return client;
  };

  /**
   * Closes the client of `scope`, as a tab that reloads: its sources stop being observed, and the
   * commands it had not settled go with it (a durable queue may send them again, as the app's).
   * The next step that needs the client opens a new one.
   */
  restart = async (scope = this.world.scope) => {
    const client = this.clients.get(scope);

    if (!client) return;

    const gone = this.runs.filter((run) => run.scope === scope && pending(run));

    for (const each of client.observed.values()) each.close();

    this.clients.delete(scope);
    client.wire.watchers.splice(client.wire.watchers.indexOf(client.watcher), 1);

    await this.connector.close(client.db, scope);
    await Promise.all(gone.map((run) => run.done));

    for (const run of gone) this.runs.splice(this.runs.indexOf(run), 1);
  };

  /** The client of `scope`; it must have been opened. */
  client = (scope = this.world.scope): Client => {
    const known = this.clients.get(scope);

    if (!known) throw new Error(`The story has no client of ${scope} yet`);

    return known;
  };

  /** Every client opened so far. */
  all = () => [...this.clients.values()];

  /** Every source observed so far, in every client. */
  observed = () => this.all().flatMap((client) => [...client.observed.values()]);

  /** Materialises a source in the client of `scope` and keeps it observed. */
  observe = async <Row extends object>(source: Source<Row>, scope = this.world.scope) => {
    const client = await this.connect(scope);
    const known = client.observed.get(source.id ?? "");

    if (known) return { observed: known, opened: false };

    const collection: Watched = client.db.collection(source);
    const observed = new Observed(this, scope, collection.id, collection);

    client.observed.set(collection.id, observed);

    return { observed, opened: true };
  };

  /** Runs one command on the client of `scope` and records it; returns the record. */
  start = async (
    label: string,
    scope: string,
    by: string,
    input: Input,
    call: (db: DbClient, onCommitted: (value: Settled) => void) => Transaction,
    command: Option.Option<Declared> = Option.none(),
  ) => {
    const client = await this.connect(scope);
    const world = this.world;

    const before = new Map(
      [...client.observed.values()].map((each) => [each.id, new Map(each.rows)] as const),
    );

    const tick = world.next();
    let value = Option.none<Settled>();

    const transaction = call(client.db, (settled) => {
      value = Option.some(settled);
    });

    // A call reports its settled value a few microtasks after the transaction settles: read the
    // value after it.
    const done = transaction
      .when("settled")
      .then(
        () => Exit.void,
        (error) => Exit.fail(error),
      )
      .then(async (exit) => {
        await macrotask();

        record.outcome = Exit.match(exit, {
          onSuccess: () =>
            Option.match(value, {
              onNone: () => Outcome.Committed({ value }),
              onSome: (settled) => {
                if (Predicate.isTagged(settled, "Unconfirmed"))
                  return Outcome.Unconfirmed({ value: settled });

                return Outcome.Committed({ value });
              },
            }),
          onFailure: (cause) =>
            Option.match(
              Option.filter(Cause.findErrorOption(cause), (error) =>
                Predicate.hasProperty(error, "_tag"),
              ),
              {
                // SAFETY: a typed failure of a call is a tagged value.
                onSome: (error) => Outcome.Rejected({ error: error as Tagged }),
                onNone: () => Outcome.Died({ cause: Cause.die(Cause.squash(cause)) }),
              },
            ),
        });
      });

    const record: Run = {
      label,
      scope,
      by,
      key: this.connector.keyOf(transaction),
      commandId: transaction.id,
      transaction: Option.some(transaction),
      command,
      input,
      tick,
      step: world.step,
      before,
      outcome: Outcome.Pending(),
      ended: -1,
      done: done.then(() => {
        record.ended = world.next();
      }),
    };

    this.runs.push(record);

    return record;
  };

  /**
   * Records the commands a client sends that no story step started (a component's handler, a
   * form's `onSubmit`): as the app's, pending until their reply arrives, then `Committed` (the
   * reply; the feed's confirmation is the client's) or `Rejected` with the typed error.
   */
  private watcher = (scope: string): Watcher => {
    const own = new Map<Sent, { readonly record: Run; readonly finish: () => void }>();
    const world = this.world;
    const runs = this.runs;

    const started = (sent: Sent) =>
      Option.match(sent.commandId, {
        onNone: () => false,
        onSome: (id) => runs.some((run) => run.commandId === id),
      });

    return {
      // A story step's command is sent while the step is still in its call, before it records
      // its run: decide whose it is once that call has returned.
      sent: (sent) => queueMicrotask(() => record(sent)),
      answered: (sent, exit) => queueMicrotask(() => answer(sent, exit)),
    };

    function record(sent: Sent) {
      if (started(sent)) return;

      let finish = () => {};

      const record: Run = {
        label: `${sent.name} ${json(sent.input)}`,
        scope,
        by: "app",
        key: "",
        commandId: Option.getOrElse(sent.commandId, () => ""),
        transaction: Option.none(),
        command: Option.none(),
        input: sent.input,
        tick: world.next(),
        step: world.step,
        before: new Map(),
        outcome: Outcome.Pending(),
        ended: -1,
        done: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };

      own.set(sent, { record, finish });
      runs.push(record);
    }

    function answer(sent: Sent, exit: Exit.Exit<unknown, Tagged>) {
      const known = own.get(sent);

      if (!known) return;

      const { record, finish } = known;

      own.delete(sent);
      record.outcome = Exit.match(exit, {
        onSuccess: () => Outcome.Committed({ value: Option.none() }),
        onFailure: (cause) =>
          Option.match(
            Option.filter(Cause.findErrorOption(cause), (error) =>
              Predicate.hasProperty(error, "_tag"),
            ),
            {
              onSome: (error) => Outcome.Rejected({ error }),
              onNone: () => Outcome.Died({ cause: Cause.die(Cause.squash(cause)) }),
            },
          ),
      });
      record.ended = world.next();
      finish();
    }
  };

  /** Why the clients are not quiet now (a live feed behind the server), or `None`. */
  busy = async (): Promise<Option.Option<string>> => {
    for (const client of this.all()) {
      const reason = await this.connector.busy(client.db, client.scope);

      if (Option.isSome(reason)) return reason;
    }

    return Option.none();
  };

  /** Releases what steps activated, stops observing and closes every client. */
  dispose = async () => {
    for (const release of this.releases.splice(0)) release();

    for (const each of this.observed()) each.close();

    for (const client of this.all()) await this.connector.close(client.db, client.scope);
  };
}

/** Whether a run is still pending. */
const pending = (run: Run) => Predicate.isTagged(run.outcome, "Pending");

/** Waits until a run ended; fails when the world went quiet and it had not. */
export const ended = async (world: World, run: Run) => {
  if (pending(run)) await world.settle();

  for (let round = 0; round < 20 && pending(run); round += 1) await macrotask();

  if (pending(run))
    throw new Mismatch(`${run.label} has not settled and nothing more happens by itself`, [
      `waiting on the clock: ${json(world.clock.scheduled())} (advance it?)`,
    ]);

  return run.outcome;
};

/** The story run's TanStack DB clients, as an adapter's service. */
export class DbClients extends Context.Service<DbClients, Clients>()(
  "@highalch/tanstack-db/Clients",
) {}

/**
 * The clients adapter: built on the first data step (or a machine or screen that needs a
 * client), with the run's connector (plain TanStack DB unless one is provided). It adds the
 * clients' feeds to what the world waits on and their commands to what `idle` waits for, and
 * closes them when the story ends, before the host is disposed.
 */
export const clients = {
  service: DbClients,
  layer: Layer.effect(
    DbClients,
    Effect.gen(function* () {
      const stage = yield* CurrentStage;
      const world = stage.hosted("a data step");
      const connect = yield* Effect.serviceOption(Connect);

      const connector = Option.match(connect, {
        onNone: plainConnector,
        onSome: (make) => make(world),
      });

      const made = new Clients(world, connector);

      world.waits.push(made.busy);
      world.rests.push(() => made.runs.every((run) => !pending(run)));
      stage.describe(async () => [
        ...made.observed().map(
          (observed) =>
            `${observed.label}: ${json(
              observed.sorted().map(([, shown]) =>
                Option.match(
                  Option.liftPredicate(shown, (each) => each.pending),
                  {
                    onNone: () => shown.row,
                    onSome: () => ({ ...shown.row, $hasPendingWrites: true }),
                  },
                ),
              ),
            )}`,
        ),
        ...made.runs.map((run) => `command ${run.label}: ${run.outcome._tag}`),
      ]);
      world.idles.push(async () => {
        for (const run of made.runs) await ended(world, run);
      });

      yield* Effect.addFinalizer(() => Effect.promise(made.dispose));

      return made;
    }),
  ),
};
