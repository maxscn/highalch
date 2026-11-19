import type * as Domain from "@alchemy.run/domain";
import {
  getActiveTransaction,
  type CreateOptimisticActionsOptions,
  type DbClient,
  type MutationFnParams,
  type PacedMutationsConfig,
  type Transaction,
} from "@tanstack/db";
import { Cause, Data, Effect, Exit, Option, Predicate, type Schema } from "effect";
import { handle, type Checked, type Handlers } from "./match";
import { Defect, type TaggedFailure } from "./state";
import { connectionOf, current, cursorOf, failureOf, type Connection } from "./client";
import type * as Rows from "./rows";
import type { Subset } from "./subset";
import type { Input, Row as Entity } from "./values";

type Row = object;

/** The target of a Domain command: the id of the aggregate it addresses. */
export type TargetOf<C extends Domain.Command.Any> = C["target"]["Type"];

/** The input of a Domain command. */
export type InputOf<C extends Domain.Command.Any> = Omit<InstanceType<C>, "_tag">;

/** What a Domain command replies. */
export type ReplyOf<C extends Domain.Command.Any> = C["reply"] extends Schema.Top
  ? C["reply"]["Type"]
  : void;

/** Everything sending a Domain command can fail with, as its Api client declares it. */
export type ErrorOf<C extends Domain.Command.Any> =
  ReturnType<Domain.Api.CommandClient<C>> extends Effect.Effect<infer _A, infer E, infer _R>
    ? Extract<E, TaggedFailure>
    : never;

/**
 * One call of a command as it is sent: the aggregate it addresses and its input. Plain,
 * serialisable data. Call sites pass only the input; the target is resolved from declarations.
 */
export type Call<C extends Domain.Command.Any> = {
  readonly target: TargetOf<C>;
  readonly input: InputOf<C>;
};

/** The `metadata` key under which a transaction holds the key of the row its call addresses. */
export const createdKey = "@highalch/db/key";

/** The transaction of an `inserts` command: its metadata holds the created row's key. */
export type Created = Transaction & {
  readonly metadata: { readonly [createdKey]: string };
};

/**
 * The key of the row an `inserts` call created, known before the server answers (for example to
 * navigate to the new record at once).
 */
export const created = (transaction: Created): string => transaction.metadata[createdKey];

/**
 * How a command settled. `Committed`: the server accepted it and the feed delivered every change
 * it caused (or it has no rows to follow). `Unconfirmed`: the server accepted it, but the feed did
 * not deliver its change within the client's `settleTimeout`; its subsets reload instead.
 */
export type Settled<A> = Data.TaggedEnum<{
  Committed: { readonly reply: A; readonly stream: string; readonly version: number };
  Unconfirmed: { readonly reply: A; readonly stream: string; readonly version: number };
}>;

export interface SettledDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Settled<this["A"]>;
}

const settled = Data.taggedEnum<SettledDefinition>();

/** The constructors of a settled command (the story kit's view helpers use them). */
export const Settled = settled;

/** The reactions of one call: one handler per rejection tag or `anyOf` key, else `orElse`. */
export type Callbacks<A, E extends TaggedFailure, K extends string, H> = {
  /** The transaction's id, which is also the Domain `commandId` (idempotent on resend). */
  readonly id?: string;
  readonly onCommitted?: (value: Settled<A>) => void;
  readonly onRejected?: Checked<E, K> & H;
};

/** A command bound to its options, as `with` returns it. */
export type Options<A, E extends TaggedFailure> = {
  /** The client to run on instead of the one the `Provider` registered (tests, several accounts). */
  readonly client?: DbClient;
  readonly onCommitted?: (value: Settled<A>) => void;
  readonly onRejected?: Readonly<Partial<Record<string, (error: E) => void>>>;
};

/** How a declaration addresses and edits rows optimistically: the entity, and one call's edit. */
export type Edit = {
  readonly entity: Option.Option<Rows.Any>;
  /**
   * Resolves one call from its input in a client's scope: the key of the row it addresses (`known`
   * when it is already chosen, e.g. a create replayed by `mutationFn`) and the aggregate target.
   */
  readonly resolve: (input: Input, scope: string, known: Option.Option<string>) => CallOf;
  /** Applies the call to the ready subsets; returns how many edits it made. */
  readonly apply: (subsets: ReadonlyArray<Subset>, call: CallOf) => number;
  /** For `updates`: the input a paced call sends for a merged row. */
  readonly paced: Option.Option<(row: Entity) => Input>;
};

/** A resolved call, as the runtime handles it: what is sent, and the row key it addresses. */
export type CallOf = {
  readonly target: string;
  readonly input: Input;
  /** The key of the row the call addresses (empty for a command with no rows). */
  readonly key: string;
};

const none = () => {};

const typed = (error: unknown): error is TaggedFailure =>
  !(error instanceof Defect) && Predicate.hasProperty(error, "_tag");

/**
 * Sends one call with `commandId` and settles once the feed delivered its change, the feed
 * passed the stream's cursor after it (a change the feed does not carry), or the timeout.
 */
const persist = async <A>(
  connection: Connection,
  command: Domain.Command.Any,
  edit: Edit,
  call: CallOf,
  commandId: string,
): Promise<Settled<A>> => {
  const entity = Option.getOrUndefined(edit.entity);
  const feed = entity && connection.feeds.get(entity.feed.streamName);
  const waiter = feed?.active ? feed.settle(commandId) : undefined;
  const send = await connection.command(command.tag);
  const exit = await connection.run(send(call.target, call.input, { commandId }));

  if (Exit.isFailure(exit)) {
    waiter?.cancel();

    throw failureOf(command.tag, exit.cause);
  }

  // SAFETY: the command's reply schema decoded the reply.
  const receipt = { ...exit.value, reply: exit.value.reply as A };

  if (!waiter || !entity) return settled.Committed(receipt);

  const cancel = connection.after(connection.settleTimeout, "settle", waiter.cancel);

  // A change that arrives after the receipt (a deferred settlement) settles only on delivery.
  if (!entity.rows.deferred)
    void connection
      .stream(entity.feed.streamName)
      .then((stream) =>
        connection.run(
          stream.peek(connection.scope, {
            atLeast: { stream: receipt.stream, version: receipt.version },
          }),
        ),
      )
      .then((latest) => {
        if (Exit.isSuccess(latest)) waiter.passed(cursorOf(latest.value));
      }, none);

  const confirmed = await waiter.promise;

  cancel();

  if (confirmed) return settled.Committed(receipt);

  for (const subset of connection.ready(entity.entityName)) subset.schedule();

  return settled.Unconfirmed(receipt);
};

/** Runs the reactions of a settled call. */
const react = <A, E extends TaggedFailure>(
  exit: Exit.Exit<Settled<A>, E>,
  options: Options<A, E>,
) =>
  Exit.match(exit, {
    onSuccess: (value) => options.onCommitted?.(value),
    onFailure: (cause) =>
      Option.map(Cause.findErrorOption(cause), (error) => {
        const handlers = options.onRejected;

        if (handlers && (handlers[error._tag] || handlers["orElse"])) handle(error, handlers);
      }),
  });

/**
 * Starts one call on a client: one TanStack DB transaction whose id is the `commandId`, holding
 * the optimistic edit; it commits when the call settles and rolls back with the original error
 * when it is rejected. A call that edits no loaded row runs the command beside an empty
 * transaction, which settles the same way.
 */
const start = <A, E extends TaggedFailure>(
  db: DbClient,
  command: Domain.Command.Any,
  edit: Edit,
  input: Input,
  options: Options<A, E> & { readonly id?: string },
) => {
  const connection = connectionOf(db);
  const call = edit.resolve(input, connection.scope, Option.none());
  let value: Option.Option<Settled<A>> = Option.none();

  const run = (commandId: string) =>
    persist<A>(connection, command, edit, call, commandId).then((result) => {
      value = Option.some(result);
    });

  const transaction = db.createTransaction({
    id: options.id,
    autoCommit: false,
    metadata: { [createdKey]: call.key },
    mutationFn: ({ transaction: running }) => run(running.id),
  });

  const subsets = Option.match(edit.entity, {
    onNone: () => [],
    onSome: (entity) => connection.ready(entity.entityName),
  });

  try {
    transaction.mutate(() => edit.apply(subsets, call));
  } catch (cause) {
    transaction.rollback();

    throw cause;
  }

  const fail = (cause: Error) => transaction.rollback({ error: cause });

  if (transaction.mutations.length > 0) void transaction.commit().catch(none);
  else void run(transaction.id).then(() => transaction.commit(), fail);

  const outcome = transaction.when("settled").then(
    (): Exit.Exit<Settled<A>, E> =>
      Option.match(value, {
        onNone: () => Exit.die(new Error(`${command.tag} settled without a result`)),
        onSome: Exit.succeed,
      }),
    (cause): Exit.Exit<Settled<A>, E> => {
      if (!typed(cause)) return Exit.die(cause);

      // SAFETY: a typed failure of the call is one of the command's declared errors.
      const error = cause as E;

      return Exit.fail(error);
    },
  );

  void outcome.then((exit) => react(exit, options));

  // Closing the client waits until this call settled, its rows edited or rolled back.
  void connection.track(outcome);

  return { transaction, outcome };
};

/** Reads a settled call's exit: its value, its typed error, or its defect thrown as itself. */
const unwrap = <A, E>(exit: Exit.Exit<A, E>): A | E =>
  Exit.match(exit, {
    onSuccess: (result): A | E => result,
    onFailure: (cause): A | E => {
      const error = Cause.findErrorOption(cause);

      if (Option.isSome(error)) return error.value;

      throw Cause.squash(cause);
    },
  });

/**
 * A command's calls, as a callable that returns TanStack DB's native transaction. Calls take only
 * the command's input: the target comes from the declaration.
 */
export type Command<
  C extends Domain.Command.Any,
  Extra = {},
  T extends Transaction = Transaction,
> = Extra & {
  /**
   * Applies the optimistic edit and sends the command; returns the transaction, which settles
   * when the feed delivered the change and rejects `when("settled")` with a typed rejection.
   */
  <const K extends string = never, H extends Handlers<ErrorOf<C>, K> = Handlers<ErrorOf<C>, K>>(
    input: InputOf<C>,
    callbacks?: Callbacks<ReplyOf<C>, ErrorOf<C>, K, H>,
  ): T;
  /** The command with a client and default reactions. */
  readonly with: <
    const K extends string = never,
    H extends Handlers<ErrorOf<C>, K> = never,
  >(options: {
    readonly client?: DbClient;
    readonly onCommitted?: (value: Settled<ReplyOf<C>>) => void;
    readonly onRejected?: Checked<ErrorOf<C>, K> & H;
  }) => Command<C, Extra, T>;
  /** The call as an Effect with the command's typed error channel. */
  readonly effect: (input: InputOf<C>) => Effect.Effect<Settled<ReplyOf<C>>, ErrorOf<C>>;
  /** The call's outcome as a value for `match`; it never rejects for a typed error. */
  readonly result: (input: InputOf<C>) => Promise<Settled<ReplyOf<C>> | ErrorOf<C>>;
  /**
   * `onMutate` and `mutationFn` for TanStack DB's `createOptimisticAction`. The transaction's
   * `metadata` holds the addressed row's key, as for a direct call.
   */
  readonly options: CreateOptimisticActionsOptions<InputOf<C>>;
};

/** A command whose calls can be paced: `usePacedMutations` merges calls into one transaction. */
export type Paced<C extends Domain.Command.Any> = Command<
  C,
  {
    /**
     * `onMutate` and `mutationFn` for `usePacedMutations` (add a `strategy`). The `mutationFn`
     * sends one command per edited row, its input read from the merged row (the row's fields that
     * are input fields, or the declaration's `input(row)`), with the command id
     * `<transaction id>:<row key>`.
     */
    readonly paced: Omit<PacedMutationsConfig<InputOf<C>>, "strategy">;
  }
>;

/** Builds a command's callable over its declaration's edit. */
export const make = <C extends Domain.Command.Any>(
  command: C,
  edit: Edit,
  bound: Options<ReplyOf<C>, ErrorOf<C>> = {},
): Command<C> => {
  type A = ReplyOf<C>;

  type E = ErrorOf<C>;

  const clientOf = () => bound.client ?? current();

  const call = (
    input: InputOf<C>,
    callbacks: Options<A, E> & { readonly id?: string } = {},
  ): Transaction =>
    start<A, E>(clientOf(), command, edit, input, {
      id: callbacks.id,
      onCommitted: callbacks.onCommitted ?? bound.onCommitted,
      onRejected: callbacks.onRejected ?? bound.onRejected,
    }).transaction;

  const outcome = (input: InputOf<C>) =>
    start<A, E>(clientOf(), command, edit, input, bound).outcome;

  const options: CreateOptimisticActionsOptions<InputOf<C>> = {
    onMutate: (input) => {
      const db = clientOf();
      const connection = connectionOf(db);
      const active = getActiveTransaction();
      const call = edit.resolve(input, connection.scope, Option.none());

      // `mutationFn` replays the call with the same key (a create's key is chosen here).
      if (active) active.metadata[createdKey] = call.key;

      const subsets = Option.match(edit.entity, {
        onNone: () => [],
        onSome: (entity) => connection.ready(entity.entityName),
      });

      if (edit.apply(subsets, call) > 0) return;

      // An empty transaction never runs its `mutationFn`: the command runs beside it.
      const id = active?.id ?? crypto.randomUUID();

      void connection.track(persist<A>(connection, command, edit, call, id)).then(
        (value) => react<A, E>(Exit.succeed(value), bound),
        (cause) => {
          if (!typed(cause)) return;

          // SAFETY: a typed failure of the call is one of the command's declared errors.
          const error = cause as E;

          react<A, E>(Exit.fail(error), bound);
        },
      );
    },
    mutationFn: (input, params: MutationFnParams) => {
      const connection = connectionOf(clientOf());
      const key = params.transaction.metadata[createdKey];
      const known = Option.liftPredicate(key, Predicate.isString);
      const call = edit.resolve(input, connection.scope, known);

      return connection.track(persist<A>(connection, command, edit, call, params.transaction.id));
    },
  };

  const rebind = (next: Options<A, E>) => make(command, edit, { ...bound, ...next });

  const callable = Object.assign(call, {
    with: rebind,
    effect: (input: InputOf<C>) =>
      Effect.promise(() => outcome(input)).pipe(
        Effect.flatMap((exit) => exit),
        Effect.withSpan(`HighAlch.command ${command.tag}`),
      ),
    result: (input: InputOf<C>) => outcome(input).then(unwrap),
    options,
    paced: Option.getOrUndefined(
      Option.map(edit.paced, (inputOf) => pace(command, edit, inputOf, clientOf)),
    ),
  });

  // SAFETY: `with` and the callable check their handlers by type; at runtime handlers are a
  // record of reactions, which is what `start` reads.
  return callable as never;
};

/**
 * The paced variant of an `updates` command. Each call resolves its row key and target as a direct
 * call does; the merged transaction sends one command per row, to the target its calls resolved.
 */
const pace = <C extends Domain.Command.Any>(
  command: C,
  edit: Edit,
  inputOf: (row: Entity) => Input,
  clientOf: () => DbClient,
): Omit<PacedMutationsConfig<InputOf<C>>, "strategy"> => {
  const targets = new Map<string, string>();

  return {
    onMutate: (input) => {
      const connection = connectionOf(clientOf());
      const call = edit.resolve(input, connection.scope, Option.none());

      targets.set(call.key, call.target);
      Option.map(edit.entity, (entity) => edit.apply(connection.ready(entity.entityName), call));
    },
    mutationFn: async ({ transaction }) => {
      const connection = connectionOf(clientOf());
      const rows = new Map<string, Row>();

      for (const mutation of transaction.mutations)
        rows.set(String(mutation.key), mutation.modified);

      await connection.track(
        Promise.all(
          [...rows].map(([key, row]) => {
            const input = inputOf(row);
            const resolved = edit.resolve(input, connection.scope, Option.some(key));
            const target = targets.get(key) ?? resolved.target;

            targets.delete(key);

            return persist(
              connection,
              command,
              edit,
              { ...resolved, target },
              `${transaction.id}:${key}`,
            );
          }),
        ),
      );
    },
  };
};
