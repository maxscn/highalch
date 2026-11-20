import type * as Domain from "@alchemy.run/domain";
import * as DomainRead from "@alchemy.run/domain/Read";
import {
  getLiveQueryStatusFlags,
  type CollectionStatus,
  type DbClient,
  type HealthNode,
  type Transaction,
} from "@tanstack/db";
import { Cause, Data, Effect, Exit, Layer, Option, Predicate, Schema, Stream } from "effect";
import * as HighAlch from "@highalch/tanstack-db";
import {
  createdKey,
  Defect,
  type Retry,
  type Settings,
  type Settled,
  type TaggedFailure,
} from "@highalch/tanstack-db";
import {
  connectionOf,
  fromLive,
  keyOf,
  type Answer,
  type Connection,
  type Input,
  type Row,
  type Rows,
} from "@highalch/tanstack-db/internal";
import { Clock } from "./clock";
import type { Host } from "./host";
import { endpointsOf, isFeed, Wire, type Endpoints } from "./wire";

/** A row as a story compares it: its fields, without TanStack DB's virtual `$` fields. */
export type Plain = Readonly<Record<string, Field>>;

/** A field of a row (any value, or nothing). */
export type Field = Answer | null | undefined;

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
export const plain = (row: Row): Plain =>
  Object.fromEntries(Object.entries(row).filter(([name]) => !name.startsWith("$")));

/** A row as stable JSON (fields sorted), for comparisons. */
export const json = <V>(value: V): string =>
  JSON.stringify(value, (_key, field: Field) => {
    if (Predicate.isObject(field) && !Array.isArray(field))
      return Object.fromEntries(Object.entries(field).sort(([a], [b]) => a.localeCompare(b)));

    return field;
  });

/** A source a consumer passes to `useLiveQuery`: a collection descriptor. */
export type Source<Row extends object = object> = HighAlch.Source<Row>;

/** The row type of a source. */
export type RowOf<S> = S extends HighAlch.Source<infer Row> ? Row : never;

/** One change of a collection, as a story reads it (with TanStack DB's virtual fields). */
type Change = {
  readonly type: string;
  readonly key: string | number;
  readonly value: object & { readonly $hasPendingWrites?: boolean };
};

/** What a story reads of a collection: its id, state, rows and changes; `reload` for `retry`. */
export type Watched = {
  readonly id: string;
  readonly status: CollectionStatus;
  readonly health: HealthNode;
  readonly values: () => Iterable<object>;
  readonly reload: () => Promise<void>;
  readonly subscribeChanges: (
    callback: (changes: ReadonlyArray<Change>) => void,
    options: { readonly includeInitialState: boolean },
  ) => { readonly unsubscribe: () => void };
};

/**
 * One source a story's client materialised and keeps observed, as a mounted `useLiveQuery`
 * would: its rows now (with their pending flag) and every change it showed.
 */
export class Observed {
  readonly rows = new Map<string, Shown>();
  readonly history: Array<Observation> = [];
  private readonly subscription: { readonly unsubscribe: () => void };

  constructor(
    readonly world: World,
    readonly scope: string,
    readonly label: string,
    readonly collection: Watched,
  ) {
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

  /** The entity whose subset this is, when it is one (a `HighAlch.query` result is not). */
  entity = (): Option.Option<Rows.Any> => {
    for (const subsets of connectionOf(this.world.client(this.scope).db).subsets.values())
      for (const subset of subsets)
        if (subset.collection.id === this.collection.id) return Option.some(subset.entity);

    return Option.none();
  };

  /** The rows now, by key. */
  sorted = () => [...this.rows].sort(([a], [b]) => a.localeCompare(b));

  /**
   * The source's read state as `match` reads a stock live query result over it: `Loading`,
   * `Retrying`, `Ready`, `Missing` (with `single`), or the typed error.
   */
  state = (single = false): TaggedFailure => {
    const collection = this.collection;
    const rows = [...collection.values()];

    const data = Option.match(
      Option.liftPredicate(rows, () => single),
      {
        onNone: () => rows,
        onSome: (found) => found[0],
      },
    );

    const flags = getLiveQueryStatusFlags(collection.status, collection.health);

    return fromLive({ ...flags, data, status: collection.status, isEnabled: true, collection })
      .state;
  };

  close = () => this.subscription.unsubscribe();
}

/**
 * How a command of a story ended: still `Pending`; `Committed` (its `Settled` value when the call
 * reported one) or `Unconfirmed`; `Rejected` with its typed error; or `Died` with a defect.
 */
export type Outcome = Data.TaggedEnum<{
  Pending: {};
  Committed: { readonly value: Option.Option<Settled<Reply>> };
  Unconfirmed: { readonly value: Settled<Reply> };
  Rejected: { readonly error: TaggedFailure };
  Died: { readonly cause: Cause.Cause<never> };
}>;

export const Outcome = Data.taggedEnum<Outcome>();

/** What a command replies, as a story holds it. */
export type Reply = Answer | void;

/** A declared `HighAlch` command, as a story holds it (to compare it with what a machine ran). */
export interface Declared {}

/** A command one of the story's clients ran (a `when` step, or one a machine invoked). */
export type Run = {
  readonly label: string;
  readonly scope: string;
  /** What ran it: the story itself or a machine. */
  readonly by: string;
  /** The key of the row it addresses (empty for a command with no rows). */
  readonly key: string;
  readonly transaction: Transaction;
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

/** One entry of a feed, as a story reads the feed to judge what its clients showed. */
export type Entry = {
  readonly seq: number;
  readonly commandId: string;
  readonly entity: string;
  readonly key: string;
  /** The row after it, decoded by its entity's schema (`None`: removed). */
  readonly row: Option.Option<Plain>;
};

/** One client of a story: an account's `DbClient`, its wire, and the sources it observes. */
export type Client = {
  readonly scope: string;
  readonly db: DbClient;
  readonly wire: Wire;
  readonly observed: Map<string, Observed>;
};

/** What a story's clients are, besides how they reach the Api. */
export type Options = Partial<Omit<Settings, "scope" | "timers">> & {
  /** The clock retries, reload debounces and settle timeouts wait on (default `manual`). */
  readonly clock?: "manual" | "real";
};

/** Retries transport failures (every 100 ms on the story's clock); stops for anything else. */
export const retryTransport: Retry = (error) =>
  Option.liftPredicate(100, () => Predicate.isTagged(error, "RpcClientError"));

/** Lets timers, I/O and the fibers they wake run once. */
export const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A value a kind of step keeps on a story's stage (a machine's snapshot or actor). */
export interface Slot {}

const Frame = Schema.Struct({
  envelope: Schema.Struct({ seq: Schema.Number, commandId: Schema.String }),
  event: Schema.Struct({
    _tag: Schema.String,
    entity: Schema.String,
    key: Schema.optionalKey(Schema.String),
    row: Schema.optionalKey(Schema.Unknown),
    cause: Schema.optionalKey(Schema.String),
  }),
});

/**
 * Everything one story run holds: its host, its clients (one per scope), the clock they wait on,
 * the commands they ran and every row state they showed. Steps act on it; `check` steps and
 * invariants read it. Nothing is global: a story builds its own world and disposes it.
 */
export class World<A extends Domain.Api.Any = Domain.Api.Any> {
  /** The observation counter. */
  tick = 0;
  /** The step running now (from 1). */
  step = 0;
  /** The tick at which the world last settled. */
  settled = -1;
  readonly clock: Clock;
  readonly runs: Array<Run> = [];
  private readonly clients = new Map<string, Client>();
  private readonly raws = new Map<string, Promise<Endpoints>>();
  /** Releases of clients `activate`d by steps, run when the story ends. */
  readonly releases: Array<() => void> = [];
  /** Extra conditions for quiet, from extensions (a running machine). */
  readonly quiet: Array<() => boolean> = [];
  private readonly queries: ReadonlySet<string>;

  /** The scope steps act as now: the story's first scope, or the one an `as` step names. */
  scope: string;

  constructor(
    readonly host: Host<A>,
    readonly home: string,
    readonly options: Options,
  ) {
    this.scope = home;
    this.clock = new Clock(options.clock ?? "manual");

    this.queries = new Set(
      host.api.serves.flatMap((each) => {
        if (Predicate.hasProperty(each, "queryName") && Predicate.isString(each.queryName))
          return [each.queryName];

        return [];
      }),
    );
  }

  next = () => (this.tick += 1);

  /** The Api client a reader of `scope` uses, unwrapped: "another client". */
  raw = (scope: string) => {
    const known = this.raws.get(scope);

    if (known) return known;

    const made = this.host.client(scope).then(endpointsOf);

    this.raws.set(scope, made);

    return made;
  };

  /** Opens the client of `scope`. */
  connect = async (scope = this.scope): Promise<Client> => {
    const known = this.clients.get(scope);

    if (known) return known;

    const wire = new Wire();
    const raw = await this.raw(scope);
    const api = this.host.api;
    const { live, retry, settleTimeout, reloadDelay, gcTime } = this.options;

    // SAFETY: the wrapped client has the Api client's endpoints, as its `Client` key yields them.
    const layer = Layer.succeed(api.Client, wire.wrap(raw, this.queries) as never);

    const db = HighAlch.make({
      api,
      layer,
      scope,
      live,
      gcTime,
      reloadDelay: reloadDelay ?? 10,
      settleTimeout: settleTimeout ?? 2_000,
      retry: retry ?? retryTransport,
      timers: this.clock.timers,
    });

    const client = { scope, db, wire, observed: new Map<string, Observed>() };

    this.clients.set(scope, client);

    return client;
  };

  /** The client of `scope`; it must have been opened. */
  client = (scope = this.scope): Client => {
    const known = this.clients.get(scope);

    if (!known) throw new Error(`The story has no client of ${scope} yet`);

    return known;
  };

  /** Every client opened so far. */
  all = () => [...this.clients.values()];

  /** Every source observed so far, in every client. */
  observed = () => this.all().flatMap((client) => [...client.observed.values()]);

  /** Materialises a source in the client of `scope` and keeps it observed. */
  observe = async <Row extends object>(source: Source<Row>, scope = this.scope) => {
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
    call: (db: DbClient, onCommitted: (value: Settled<Reply>) => void) => Transaction,
    command: Option.Option<Declared> = Option.none(),
  ) => {
    const client = await this.connect(scope);

    const before = new Map(
      [...client.observed.values()].map((each) => [each.id, new Map(each.rows)] as const),
    );

    const tick = this.next();
    let value = Option.none<Settled<Reply>>();

    const transaction = call(client.db, (settled) => {
      value = Option.some(settled);
    });

    const key = transaction.metadata[createdKey];

    // `onCommitted` runs a few microtasks after the transaction settles: read the value after it.
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
                onSome: (error) => Outcome.Rejected({ error: error as TaggedFailure }),
                onNone: () => Outcome.Died({ cause: Cause.die(Cause.squash(cause)) }),
              },
            ),
        });
      });

    const record: Run = {
      label,
      scope,
      by,
      key: Predicate.isString(key) ? key : "",
      transaction,
      command,
      input,
      tick,
      step: this.step,
      before,
      outcome: Outcome.Pending(),
      ended: -1,
      done: done.then(() => {
        record.ended = this.next();
      }),
    };

    this.runs.push(record);

    return record;
  };

  /**
   * The feed entries of every entity the clients of `scope` read, in order, with rows decoded by
   * their entity's schema. Read from the Domain itself (not through the story's wire).
   */
  entries = async (scope = this.scope): Promise<ReadonlyArray<Entry>> => {
    const client = this.clients.get(scope);

    if (!client) return [];

    const entities = new Map<string, Rows.Any>();

    for (const subsets of connectionOf(client.db).subsets.values())
      for (const subset of subsets) entities.set(subset.entity.entityName, subset.entity);

    const streams = new Set([...entities.values()].map((entity) => entity.feed.streamName));

    const raw = await this.raw(scope);
    const read: Array<Entry> = [];

    for (const stream of streams) {
      const feed = raw[stream];

      if (!isFeed(feed)) continue;

      const frames = await Effect.runPromise(
        feed.events(scope, { after: 0 }).pipe(
          Stream.takeUntil(DomainRead.isCaughtUp),
          Stream.filter((frame) => !DomainRead.isCaughtUp(frame)),
          Stream.runCollect,
        ),
      );

      for (const frame of frames) {
        const { envelope, event } = Schema.decodeUnknownSync(Frame)(frame);
        const entity = entities.get(event.entity);

        if (!entity) continue;

        const row = Option.map(Option.fromUndefinedOr(event.row), (encoded) =>
          // SAFETY: an entity's row schema is a plain codec; decoding needs no services.
          plain(
            Schema.decodeUnknownSync(entity.rows.row as Schema.Codec<object, unknown>)(encoded),
          ),
        );

        const key = Option.match(row, {
          onNone: () => event.key ?? "",
          onSome: (decoded) => keyOf(entity.rows.key, decoded),
        });

        read.push({
          seq: envelope.seq,
          commandId: event.cause ?? envelope.commandId,
          entity: entity.entityName,
          key,
          row,
        });
      }
    }

    return read.sort((a, b) => a.seq - b.seq);
  };

  /** The server's latest `seq` of a stream for a scope, read from the Domain itself. */
  private cursor = async (scope: string, stream: string) => {
    const feed = (await this.raw(scope))[stream];

    if (!isFeed(feed)) return 0;

    const latest = await Effect.runPromiseExit(feed.peek(scope));

    return Exit.match(latest, {
      onFailure: () => 0,
      onSuccess: (entry) => entry?.envelope.seq ?? 0,
    });
  };

  /** Why the world is not quiet now, or `None`. */
  busy = async (): Promise<Option.Option<string>> => {
    if (this.host.idle && !(await this.host.idle())) return Option.some("the server is busy");

    if (this.clock.mode === "real" && this.clock.waiting("retry", "reload"))
      return Option.some("a retry or reload is about to run");

    for (const client of this.all()) {
      if (client.wire.inflight > 0)
        return Option.some(`${client.scope}: ${client.wire.inflight} request(s) in flight`);

      const connection: Connection = connectionOf(client.db);

      for (const [stream, feed] of connection.feeds) {
        if (!feed.active) continue;

        if (client.wire.lossy) continue;

        if (!feed.current) {
          if (client.wire.dropped || this.clock.waiting("retry")) continue;

          return Option.some(`${client.scope}: the ${stream} feed is connecting`);
        }

        const cursor = await this.cursor(client.scope, stream);

        if (feed.seq < cursor)
          return Option.some(`${client.scope}: the ${stream} feed is at ${feed.seq} of ${cursor}`);
      }
    }

    if (!this.quiet.every((check) => check())) return Option.some("a machine is busy");

    return Option.none();
  };

  /**
   * Waits until nothing more happens by itself: the server is idle, no request is in flight, every
   * live feed delivered the server's latest entry, and (with the real clock) no retry or reload is
   * due. Waits on the story's manual clock never fire here: `advance` fires them. Command replies
   * reach the clients only while the world settles; `flow: false` waits without letting them
   * through (the client and its machines catch up, the commands stay in flight).
   */
  settle = async (flow = true) => {
    let quiet = 0;
    let reason = Option.none<string>();
    const deadline = Date.now() + 3_000;

    if (flow) for (const client of this.all()) client.wire.flow(true);

    while (quiet < 3 && Date.now() < deadline) {
      await macrotask();

      reason = await this.busy();

      if (Option.isNone(reason)) quiet += 1;
      else quiet = 0;
    }

    for (const client of this.all()) client.wire.flow(false);

    if (quiet < 3)
      throw new Error(
        `The story did not settle: ${Option.getOrElse(reason, () => "it kept changing")}`,
      );

    this.settled = this.tick;
  };

  /**
   * Settles, then fires the manual clock's waits due within `ms` (in time order), settling after
   * each.
   */
  advance = async (ms: number) => {
    // What is in flight arrives first; then time passes.
    await this.settle();

    const until = this.clock.now + ms;

    while (this.clock.fireNext(until)) await this.settle();

    this.clock.now = until;
    await this.settle();
  };

  /**
   * Closes a client. `HighAlch.close` waits until the commands it sent have settled, and a story
   * holds them (replies wait at the wire, settle timeouts on the manual clock): a story that ended
   * or failed with a command in flight lets its replies through and runs the clock's waits until
   * the close returns, so disposing never hangs. Gives up waiting after `deadline`.
   */
  private close = async (client: Client, deadline: number) => {
    let closed = false;

    const closing = HighAlch.close(client.db).finally(() => {
      closed = true;
    });

    while (!closed && Date.now() < deadline) {
      client.wire.flow(true);
      client.wire.release();
      this.clock.fireNext(Number.POSITIVE_INFINITY);
      await macrotask();
    }

    if (closed) await closing;
  };

  /** Closes every client and the host. */
  dispose = async () => {
    for (const release of this.releases.splice(0)) release();

    for (const each of this.observed()) each.close();

    const deadline = Date.now() + 3_000;

    for (const client of this.all()) await this.close(client, deadline);

    await this.host.dispose();
  };
}

/** A defect as a readable line. */
export const describeDefect = <D>(defect: D) => {
  if (defect instanceof Defect) return `${defect.name}: ${Cause.pretty(defect.cause)}`;

  return String(defect);
};
