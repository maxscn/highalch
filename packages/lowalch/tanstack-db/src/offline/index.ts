/**
 * Durable offline command calls for a LowAlch client, on TanStack DB's
 * `@tanstack/offline-transactions`: its executor stores, orders, retries and replays them, and
 * elects the tab that sends.
 *
 * ```ts
 * import * as LowAlch from "@lowalch/tanstack-db";
 * import { offline, status } from "@lowalch/tanstack-db/offline";
 *
 * const db = LowAlch.make({ api, layer, scope, offline: offline() });
 * const { data } = useLiveQuery((q) => q.from({ status }));
 * ```
 *
 * A call is stored as data (`Call`: the declaration's name, the target, the encoded input and the
 * `commandId`) in a local collection of this client, `calls`, which is the queue as rows. After a
 * reload the executor restores the rows, and each is sent again with the same `commandId`; its
 * optimistic edit shows again on every subset that loads, until it settles.
 */
import type * as Domain from "@alchemy.run/domain";
import {
  collectionOptions,
  localOnlyCollectionOptions,
  type Collection,
  type DbClient,
  type SyncConfig,
  type Transaction,
} from "@tanstack/db";
import {
  BroadcastChannelLeader,
  IndexedDBAdapter,
  LocalStorageAdapter,
  startOfflineExecutor,
  WebLocksLeader,
  type LeaderElection,
  type OfflineExecutor,
  type OnlineDetector,
  type StorageAdapter,
} from "@tanstack/offline-transactions";
import { Cause, Exit, Option, Predicate, Schema } from "effect";
import {
  closedClientError,
  connectionOf,
  failureOf,
  type Connection,
  type Offline,
  type Queue,
  type Queued,
} from "../client";
import { declaredAs, persist, type CallOf, type Edit } from "../command";
import { Defect, type TaggedFailure } from "../state";
import type { Subset } from "../subset";
import type { Input } from "../values";

/** One queued command call, as it is stored: plain data. */
export type Call = {
  /** The Domain `commandId` it is sent with, every time. */
  readonly commandId: string;
  /** The declaration that replays it: `<entity>/<declared name>`. */
  readonly name: string;
  /** The Domain command's tag. */
  readonly command: string;
  /** The aggregate it addresses, from the command's own target. */
  readonly target: string;
  /** The key of the row it edits (empty for a command with no rows). */
  readonly key: string;
  /** The command's input, encoded by its schema. */
  readonly input: unknown;
  /** When it was called (milliseconds). */
  readonly at: number;
};

/** A queued call that was rejected for good, with the original error. */
export type Rejection = Call & { readonly error: TaggedFailure | Defect };

/** What a client's queue is doing. One row, under the key `"status"`. */
export type Status = {
  readonly id: "status";
  /** The executor may send: its detector says online, and the last send reached the server. */
  readonly online: boolean;
  /** Calls stored or being sent by this tab. */
  readonly queued: number;
  /** This tab sends the queue. Another tab's calls are not stored (see the README). */
  readonly leader: boolean;
  /** Calls survive a reload: storage is available and this tab is the leader. */
  readonly durable: boolean;
};

/** How a queue is stored and coordinated. Defaults are the library's, named by the client's scope. */
export type Options = {
  /** Where calls are stored. Default: IndexedDB, else localStorage; neither: nothing is durable. */
  readonly storage?: StorageAdapter;
  /** Which tab sends. Default: Web Locks, else a BroadcastChannel, else this tab. */
  readonly leaderElection?: LeaderElection;
  /** When the network is back. Default: the library's browser detector. */
  readonly onlineDetector?: OnlineDetector;
};

type OfflineMutationFn = NonNullable<
  Parameters<typeof startOfflineExecutor>[0]["mutationFns"][string]
>;

type Waiter = {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

/** A client's running queue: what the descriptors below read. */
type Running = {
  readonly status: () => Status;
  readonly watch: (listener: () => void) => () => void;
  readonly rejections: () => Collection<Rejection, string>;
};

const running = new WeakMap<Connection, Running>();

const runningOf = (db: DbClient) => {
  const found = running.get(connectionOf(db));

  if (found) return found;

  throw new Error(
    "This LowAlch client has no offline queue: make it with `offline: offline()` from @lowalch/tanstack-db/offline",
  );
};

const none = () => {};

const callsId = "@lowalch/tanstack-db/offline/calls";

/**
 * The queue of a client, as rows: every call stored or being sent, for stock `useLiveQuery`.
 * A row leaves when its call settled or was rejected for good.
 */
export const calls = collectionOptions(callsId, (_db: DbClient) =>
  localOnlyCollectionOptions<Call, string>({
    id: callsId,
    getKey: (call) => call.commandId,
    // A queued row is only ever optimistic: it leaves with its transaction.
    onInsert: async () => {},
  }),
);

const rejectedId = "@lowalch/tanstack-db/offline/rejected";

/**
 * The calls of a client that were rejected for good while replayed, with their original errors:
 * after a reload no transaction is left to reject. Delete a row to dismiss it.
 */
export const rejected = collectionOptions(rejectedId, (_db: DbClient) =>
  localOnlyCollectionOptions<Rejection, string>({
    id: rejectedId,
    getKey: (call) => call.commandId,
  }),
);

const statusId = "@lowalch/tanstack-db/offline/status";

/** The status of a client's queue: one row (`Status`), for stock `useLiveQuery`, machines and stories. */
export const status = collectionOptions(statusId, (db: DbClient) => {
  const queue = runningOf(db);

  const sync: SyncConfig<Status, string> = {
    sync: ({ begin, write, commit, markReady }) => {
      let shown = false;

      const publish = () => {
        begin();
        write({ type: shown ? "update" : "insert", value: queue.status() });
        void commit();
        shown = true;
      };

      publish();
      markReady();

      return queue.watch(publish);
    },
  };

  return { id: statusId, getKey: (row: Status) => row.id, sync };
});

/** The schema of a command's input, as its RPC sends it. */
const inputOf = (command: Domain.Command.Any): Schema.Codec<Input, unknown> => {
  const rpc: unknown = command.rpc;

  if (
    Predicate.hasProperty(rpc, "payloadSchema") &&
    Predicate.hasProperty(rpc.payloadSchema, "fields") &&
    Predicate.hasProperty(rpc.payloadSchema.fields, "input") &&
    Schema.isSchema(rpc.payloadSchema.fields.input)
  )
    // SAFETY: a command's input needs no services to encode, and is its input's type.
    return Schema.toCodecJson(rpc.payloadSchema.fields.input) as never;

  throw new Error(`${command.tag}: its RPC payload has no input schema`);
};

/** The browser's storage for a scope, as the library probes it; none when neither works. */
const probe = async (scope: string): Promise<Option.Option<StorageAdapter>> => {
  const indexed = await IndexedDBAdapter.probe();

  if (indexed.available)
    return Option.some(new IndexedDBAdapter(`lowalch-offline:${scope}`, "calls"));

  if (LocalStorageAdapter.probe().available)
    return Option.some(new LocalStorageAdapter(`lowalch-offline:${scope}:`));

  return Option.none();
};

/** The library's leader election for a scope; none where it would fall back to this tab. */
const electionOf = (scope: string): LeaderElection | undefined => {
  const name = `lowalch-offline:${scope}`;

  if (WebLocksLeader.isSupported()) return new WebLocksLeader(name);
  if (BroadcastChannelLeader.isSupported()) return new BroadcastChannelLeader(name);

  return undefined;
};

/** A failure only a later attempt can resolve: the transport, or a declaration not loaded yet. */
const transient = (error: TaggedFailure | Defect) => Predicate.isTagged(error, "RpcClientError");

const start = (options: Options, connection: Connection, db: DbClient): Queue => {
  const queue = db.collection(calls);
  const waiters = new Map<string, Waiter>();
  /** Errors that end a call: the executor must not retry them. */
  const final = new WeakSet<object>();
  /** Calls restored from storage, still queued: shown on every subset that loads. */
  const restored = new Map<string, Call>();
  const sending = new Set<string>();
  const listeners = new Set<() => void>();
  let executor: Option.Option<OfflineExecutor> = Option.none();
  let reached = true;
  let leader = false;
  let durable = false;
  let closed = false;

  const read = (): Status => ({
    id: "status",
    online: reached && Option.match(executor, { onNone: () => true, onSome: (e) => e.isOnline() }),
    queued: queue.size,
    leader,
    durable,
  });

  const changed = () => {
    for (const listener of listeners) listener();
  };

  const waiterOf = (commandId: string) => {
    const known = waiters.get(commandId);

    if (known) return known;

    let resolve: Waiter["resolve"] = none;
    let reject: Waiter["reject"] = none;

    const promise = new Promise<unknown>((done, fail) => {
      resolve = done;
      reject = fail;
    });

    // A restored call may have no one waiting on it.
    promise.catch(none);

    const waiter = { promise, resolve, reject };

    waiters.set(commandId, waiter);

    return waiter;
  };

  const settle = (commandId: string, exit: Exit.Exit<unknown, unknown>) => {
    const waiter = waiters.get(commandId);

    waiters.delete(commandId);
    restored.delete(commandId);

    if (!waiter) return;

    if (Exit.isSuccess(exit)) waiter.resolve(exit.value);
    else waiter.reject(Cause.squash(exit.cause));
  };

  /** Sends one stored call, as often as the executor asks: with the same `commandId`. */
  const replay =
    (name: string): OfflineMutationFn =>
    async ({ transaction }) => {
      // SAFETY: a queue transaction holds one inserted `Call`.
      const stored = transaction.mutations[0]?.modified as Call | undefined;

      if (!stored) return;

      const declared = Option.getOrUndefined(declaredAs(name));

      // Its module may load later (a lazy route): the call waits, it is not dropped.
      if (!declared) throw new Error(`LowAlch: no declared command ${name} is loaded yet`);

      const input = Schema.decodeUnknownSync(inputOf(declared.command))(stored.input);
      const call: CallOf = { target: stored.target, key: stored.key, input };

      sending.add(stored.commandId);

      const exit = await connection.runQueued(
        persist(connection, declared.command, declared.edit, call, stored.commandId),
      );

      sending.delete(stored.commandId);

      if (Exit.isSuccess(exit)) {
        reached = true;
        settle(stored.commandId, exit);
        changed();

        return;
      }

      const error = Option.getOrElse(Cause.findErrorOption(exit.cause), () =>
        failureOf(stored.command, exit.cause),
      );

      // A closing client stops sending: the call stays stored for the next one.
      if (closed || connection.closingOrClosed) throw closedClientError();

      if (transient(error)) {
        reached = false;
        changed();

        throw error;
      }

      reached = true;
      final.add(error);

      if (restored.has(stored.commandId)) db.collection(rejected).insert({ ...stored, error });

      settle(stored.commandId, Exit.fail(error));
      changed();

      throw error;
    };

  /** Shows a restored call on a subset, until the call settles. */
  const show = (
    stored: Call,
    declared: { readonly edit: Edit },
    subsets: ReadonlyArray<Subset>,
  ) => {
    const waiter = waiterOf(stored.commandId);

    const transaction = db.createTransaction({
      autoCommit: false,
      mutationFn: () => waiter.promise,
    });

    try {
      const input = Schema.decodeUnknownSync(
        inputOf(Option.getOrThrow(declaredAs(stored.name)).command),
      )(stored.input);

      transaction.mutate(() =>
        declared.edit.apply(subsets, { target: stored.target, key: stored.key, input }),
      );
    } catch {
      // A row the subset no longer has: the call is sent all the same.
      transaction.rollback();

      return;
    }

    void transaction.commit().catch(none);
  };

  const arrived = (subset: Subset) => {
    const ordered = [...restored.values()].sort((a, b) => a.at - b.at);

    for (const stored of ordered)
      Option.map(declaredAs(stored.name), (declared) => {
        const shows = Option.match(declared.edit.entity, {
          onNone: () => false,
          onSome: (entity) => entity.entityName === subset.entity.entityName,
        });

        if (shows) show(stored, declared, [subset]);
      });
  };

  /** A row no call of this client put there was restored from storage: it shows on what is loaded. */
  const restore = () => {
    for (const stored of queue.values())
      if (!waiters.has(stored.commandId) && !sending.has(stored.commandId)) {
        restored.set(stored.commandId, stored);
        waiterOf(stored.commandId);

        Option.map(declaredAs(stored.name), (declared) =>
          Option.map(declared.edit.entity, (entity) =>
            show(stored, declared, connection.ready(entity.entityName)),
          ),
        );
      }

    changed();
  };

  // The queue's rows are optimistic only: observing them keeps the collection for the client.
  const observed = queue.subscribeChanges(restore, { includeInitialState: true });

  const mutationFns = new Proxy<Record<string, OfflineMutationFn>>(
    {},
    { get: (_, name) => replay(String(name)) },
  );

  const started = (async () => {
    const storage = options.storage
      ? Option.some(options.storage)
      : await probe(connection.scope).catch(() => Option.none<StorageAdapter>());

    if (closed || Option.isNone(storage)) return;

    const made = startOfflineExecutor({
      collections: { calls: queue },
      mutationFns,
      storage: storage.value,
      leaderElection: options.leaderElection ?? electionOf(connection.scope),
      onlineDetector: options.onlineDetector,
      shouldRetry: (error) => !final.has(error),
      onLeadershipChange: (leads) => {
        leader = leads;
        durable = leads;
        changed();
      },
    });

    executor = Option.some(made);
    made.getOnlineDetector().subscribe(changed);

    await made.waitForInit();

    if (closed) return made.dispose();

    changed();
  })().catch((cause: unknown) => {
    // Storage that fails to open: calls are sent at once, as without a queue.
    executor = Option.none();
    console.warn("LowAlch: the offline queue could not start; calls are not durable", cause);
  });

  /** Sends at once, as a client without a queue does. */
  const direct = async (call: Queued) => {
    const declared = Option.getOrThrow(declaredAs(call.name));
    const exit = await connection.runQueued(
      persist(connection, declared.command, declared.edit, call, call.commandId),
    );

    if (Exit.isSuccess(exit)) return exit.value;

    throw Option.getOrElse(Cause.findErrorOption(exit.cause), () =>
      failureOf(call.name, exit.cause),
    );
  };

  const send = async (call: Queued) => {
    await started;

    if (closed) throw closedClientError();
    if (Option.isNone(executor)) return direct(call);

    const declared = Option.getOrThrow(declaredAs(call.name));
    const waiter = waiterOf(call.commandId);

    const stored: Call = {
      commandId: call.commandId,
      name: call.name,
      command: declared.command.tag,
      target: call.target,
      key: call.key,
      input: Schema.encodeUnknownSync(inputOf(declared.command))(call.input),
      at: Date.now(),
    };

    const offlined = executor.value.createOfflineTransaction({
      mutationFnName: call.name,
      idempotencyKey: call.commandId,
      autoCommit: false,
    });

    const transaction: Transaction = offlined.mutate(() => queue.insert(stored));

    // The waiter carries the original error; this only reports a call that was never admitted.
    void transaction.commit().catch((cause: unknown) => {
      if (waiters.get(call.commandId) === waiter) settle(call.commandId, Exit.fail(cause));
    });

    return waiter.promise;
  };

  running.set(connection, {
    status: read,
    watch: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    rejections: () => db.collection(rejected),
  });

  return {
    send,
    arrived,
    close: () => {
      closed = true;
      observed.unsubscribe();
      Option.map(executor, (made) => made.dispose());

      // What is being sent settles on its own; what only waits rolls back, and stays stored.
      for (const commandId of waiters.keys())
        if (!sending.has(commandId)) settle(commandId, Exit.fail(closedClientError()));
    },
  };
};

/**
 * Durable offline command calls, for `LowAlch.make({ ..., offline: offline() })`. Calls are
 * stored before they are sent, sent in order by one tab, retried while the transport fails and
 * replayed with the same `commandId` after a reload.
 */
export const offline =
  (options: Options = {}): Offline =>
  (connection, db) =>
    start(options, connection, db);
