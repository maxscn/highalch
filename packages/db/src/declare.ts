import type * as Domain from "@alchemy.run/domain";
import {
  collectionOptions,
  type CollectionOptions,
  type DbClient,
  type NonSingleResult,
  type SyncConfig,
} from "@tanstack/db";
import { Exit, Option, Predicate } from "effect";
import type { Marked } from "./live";
import type { TaggedFailure } from "./state";
import { connectionOf, failureOf } from "./client";
import {
  make,
  type Command,
  type Created,
  type Edit,
  type InputOf as CommandInput,
  type Paced,
  type TargetOf,
} from "./command";
import type * as Rows from "./rows";
import { keyOf as keyIn, type Answer, type Input, type Row } from "./values";
import { Subset, type Spec } from "./subset";

/** The input of a Domain query. */
export type QueryInput<Q extends Domain.Query.Any> = Domain.Query.InputOf<Q>;

/** One entry of a query's answer: a page's entry, an array's element, or the one result. */
export type EntryOf<Q extends Domain.Query.Any> =
  Domain.Query.ResultOf<Q> extends Domain.Query.Page<infer Entry>
    ? Entry
    : Domain.Query.ResultOf<Q> extends ReadonlyArray<infer Entry>
      ? Entry
      : NonNullable<Domain.Query.ResultOf<Q>>;

/** A page of a paged query; part of a subset's identity. */
export type Page = { readonly after?: string; readonly take?: number };

type PageArgs<Q extends Domain.Query.Any> =
  NonNullable<Q["definition"]["paged"]> extends true ? [page?: Page] : [];

/** A subset accessor's arguments: the query's input (optional when it has no field), a page. */
export type Args<Q extends Domain.Query.Any> =
  {} extends QueryInput<Q>
    ? [input?: QueryInput<Q>, ...PageArgs<Q>]
    : [input: QueryInput<Q>, ...PageArgs<Q>];

/** A subset collection's descriptor: usable directly as a source of `useLiveQuery`. */
export type Source<Row extends object> = CollectionOptions<Row, string> & NonSingleResult;

/** A query with a membership rule: `one` (one row) or `where` (rows). */
export class Membership<Q extends Domain.Query.Any> {
  constructor(
    readonly query: Q,
    readonly rule: (row: EntryOf<Q>, input: QueryInput<Q>) => boolean,
    readonly single: boolean,
  ) {}
}

/**
 * A single-row query (`get`) with its membership rule: a feed row for which the rule holds is
 * inserted into the subset; read it with `.findOne()` for `Missing`.
 */
export const one = <Q extends Domain.Query.Any>(
  query: Q,
  rule: (row: EntryOf<Q>, input: QueryInput<Q>) => boolean,
) => new Membership(query, rule, true);

/** A many-row query with its membership rule: feed rows for which it holds are inserted. */
export const where = <Q extends Domain.Query.Any>(
  query: Q,
  rule: (row: EntryOf<Q>, input: QueryInput<Q>) => boolean,
) => new Membership(query, rule, false);

/** A query whose answer wraps its rows, with the reader of its rows and an optional rule. */
export class Entries<Q extends Domain.Query.Any, Entry> {
  constructor(
    readonly query: Q,
    readonly select: (answer: NonNullable<Domain.Query.ResultOf<Q>>) => ReadonlyArray<Entry>,
    readonly rule: Option.Option<(row: Entry, input: QueryInput<Q>) => boolean>,
  ) {}
}

/**
 * A query whose answer holds its rows inside a wrapper that is not a `paged` page (for example
 * `{ Items, Count, LastEvaluatedKey }`): `select` reads the rows from one answer. With `rule`, feed
 * rows for which it holds are inserted, as for `where`; without one, an unknown row reloads it.
 */
export const entries = <Q extends Domain.Query.Any, Entry>(
  query: Q,
  select: (answer: NonNullable<Domain.Query.ResultOf<Q>>) => ReadonlyArray<Entry>,
  rule?: (row: Entry, input: QueryInput<Q>) => boolean,
) => new Entries(query, select, Option.fromUndefinedOr(rule));

/** Reads the key of the row a call addresses from its input. */
export type KeyFn<C extends Domain.Command.Any> = (input: CommandInput<C>) => string;

/** Gives the aggregate a call addresses, from its input and the client's scope. */
export type TargetFn<C extends Domain.Command.Any> = (
  input: CommandInput<C>,
  scope: string,
) => TargetOf<C>;

/**
 * How a command finds what it addresses. `key`: the row key, read from the input (by default the
 * input's field named like the row key). `target`: the aggregate, instead of the `Rows` entity's
 * `target` for that key.
 */
export type Addressing<C extends Domain.Command.Any> = {
  readonly key?: KeyFn<C>;
  readonly target?: TargetFn<C>;
};

/** Whether options declare a function under a name. */
type Has<O, Name extends string> = O extends { readonly [K in Name]: (...args: never) => string }
  ? true
  : false;

/** Type-level only: which of `key` and `target` a declaration gives. */
type Declares<HasKey extends boolean, HasTarget extends boolean> = {
  readonly key: HasKey;
  readonly target: HasTarget;
};

/** A declaration's addressing at runtime. */
type Resolved = {
  readonly key: Option.Option<(input: Input) => string>;
  readonly target: Option.Option<(input: Input, scope: string, key: string) => string>;
};

/** Reads a declaration's addressing options. */
const addressing = (options: {
  readonly key?: (input: never) => string;
  readonly target?: (input: never, scope: string, key: string) => string;
}): Resolved => ({
  // SAFETY: the options were checked against this command's input when declared.
  key: Option.fromUndefinedOr(options.key as ((input: Input) => string) | undefined),
  // SAFETY: as above, for the target.
  target: Option.fromUndefinedOr(
    options.target as ((input: Input, scope: string, key: string) => string) | undefined,
  ),
});

/** The options of `inserts`: the pending row, and optionally its key and target. */
export type InsertOptions<C extends Domain.Command.Any, P extends object> = {
  /** The pending row shown until the feed delivers the server's row; checked against the row. */
  readonly row: (input: CommandInput<C>, key: string) => P;
  /** The created row's key; by default a fresh client-generated id (`crypto.randomUUID()`). */
  readonly key?: KeyFn<C>;
  /** The aggregate the create addresses, instead of the `Rows` entity's `target` for the key. */
  readonly target?: (input: CommandInput<C>, scope: string, key: string) => TargetOf<C>;
};

/** A create, as `inserts` declares it. */
export class Inserts<C extends Domain.Command.Any, P extends object, HasTarget extends boolean> {
  readonly kind = "inserts";
  declare readonly "~declares": Declares<true, HasTarget>;

  constructor(
    readonly command: C,
    readonly pending: (input: CommandInput<C>, key: string) => P,
    readonly addressing: Resolved,
  ) {}
}

/**
 * The options of `updates`: its addressing, and where the row fields of an input are when the
 * input does not hold them as its own fields (for example `{ value: { ...fields } }`).
 */
export type UpdateOptions<C extends Domain.Command.Any, P extends object> = Addressing<C> & {
  /** The row fields a call sets; by default the input's own fields. */
  readonly fields?: (input: CommandInput<C>) => Partial<P>;
  /** The input a paced call sends for a merged row; by default the row's fields that are inputs. */
  readonly input?: (row: P) => CommandInput<C>;
};

/** Where an update's row fields are, at runtime. */
type Fields = {
  readonly fields: Option.Option<(input: Input) => Input>;
  readonly input: Option.Option<(row: Row) => Input>;
};

const plain: Fields = { fields: Option.none(), input: Option.none() };

/** An update or a delete of the row a call names, as `updates` or `deletes` declares it. */
export class Keyed<
  C extends Domain.Command.Any,
  Kind extends "updates" | "deletes",
  HasKey extends boolean,
  HasTarget extends boolean,
> {
  declare readonly "~declares": Declares<HasKey, HasTarget>;

  constructor(
    readonly command: C,
    readonly kind: Kind,
    readonly addressing: Resolved,
    readonly values: Fields = plain,
  ) {}
}

/** A custom edit of the row a call names, as `edits` declares it. */
export class Edits<
  C extends Domain.Command.Any,
  P extends object,
  HasKey extends boolean,
  HasTarget extends boolean,
> {
  readonly kind = "edits";
  declare readonly "~declares": Declares<HasKey, HasTarget>;

  constructor(
    readonly command: C,
    readonly change: (draft: Draft<P>, input: CommandInput<C>) => void,
    readonly addressing: Resolved,
  ) {}
}

/** An entity command with no optimistic change, as `sends` declares it. */
export class Sends<
  C extends Domain.Command.Any,
  HasKey extends boolean,
  HasTarget extends boolean,
> {
  readonly kind = "sends";
  declare readonly "~declares": Declares<HasKey, HasTarget>;

  constructor(
    readonly command: C,
    readonly addressing: Resolved,
  ) {}
}

/**
 * A create: `row` builds the pending row from the input and the created key, shown until the feed
 * delivers the server's row. The key is `key(input)` or a fresh id; the call's transaction holds
 * it (read it with `HighAlch.created(transaction)`).
 */
export const inserts = <
  C extends Domain.Command.Any,
  P extends object,
  const O extends InsertOptions<C, P> = InsertOptions<C, P>,
>(
  command: C,
  options: O & InsertOptions<C, P>,
): Inserts<C, P, Has<O, "target">> => new Inserts(command, options.row, addressing(options));

/**
 * An update: the input's fields that are row fields replace the row's (or those `fields(input)`
 * answers, when the input nests them).
 */
export const updates = <
  C extends Domain.Command.Any,
  P extends object = object,
  const O extends UpdateOptions<C, P> = {},
>(
  command: C,
  options?: O & UpdateOptions<C, P>,
): Keyed<C, "updates", Has<O, "key">, Has<O, "target">> =>
  new Keyed(command, "updates", addressing(options ?? {}), {
    // SAFETY: the readers were checked against this command's input and row when declared.
    fields: Option.fromUndefinedOr(options?.fields as ((input: Input) => Input) | undefined),
    // SAFETY: as above.
    input: Option.fromUndefinedOr(options?.input as ((row: Row) => Input) | undefined),
  });

/** A delete: the row leaves every subset that shows it. */
export const deletes = <C extends Domain.Command.Any, const O extends Addressing<C> = {}>(
  command: C,
  options?: O & Addressing<C>,
): Keyed<C, "deletes", Has<O, "key">, Has<O, "target">> =>
  new Keyed(command, "deletes", addressing(options ?? {}));

/** A custom edit: `change` changes a draft of the row (typed from the collection's row). */
export const edits = <
  C extends Domain.Command.Any,
  P extends object,
  const O extends Addressing<C> = {},
>(
  command: C,
  options: O &
    Addressing<C> & { readonly change: (draft: Draft<P>, input: CommandInput<C>) => void },
): Edits<C, P, Has<O, "key">, Has<O, "target">> =>
  new Edits(command, options.change, addressing(options));

/**
 * An entity command with no optimistic change that needs `key` or `target` (a bare command in
 * `commands` addresses the row its input's key field names, through the entity's `target`).
 */
export const sends = <C extends Domain.Command.Any, const O extends Addressing<C> = {}>(
  command: C,
  options?: O & Addressing<C>,
): Sends<C, Has<O, "key">, Has<O, "target">> => new Sends(command, addressing(options ?? {}));

/** What `queries` may hold: a bare query, one with a membership rule, or one with `entries`. */
export type QuerySpec =
  | Domain.Query.Any
  // oxlint-disable-next-line typescript/no-explicit-any
  | Membership<any>
  // oxlint-disable-next-line typescript/no-explicit-any
  | Entries<any, any>;

/** A row being edited: its fields writable. */
export type Draft<P> = { -readonly [K in keyof P]: P[K] };

/**
 * What `commands` may hold for rows `Row`: a bare command (no optimistic change), or one declared
 * with `inserts`, `updates`, `deletes`, `edits` or `sends`. (`any` leaves each command's own input
 * types to its declaration; the row type is checked, and `collection` checks keys and targets.)
 */
export type CommandSpec<Row extends object> =
  | Domain.Command.Any
  // oxlint-disable-next-line typescript/no-explicit-any
  | Inserts<any, Row, boolean>
  // oxlint-disable-next-line typescript/no-explicit-any
  | Keyed<any, "updates" | "deletes", boolean, boolean>
  // oxlint-disable-next-line typescript/no-explicit-any
  | Edits<any, Row, boolean, boolean>
  // oxlint-disable-next-line typescript/no-explicit-any
  | Sends<any, boolean, boolean>;

type QueryOf<S> =
  S extends Membership<infer Q>
    ? Q
    : S extends Entries<infer Q, infer _Entry>
      ? Q
      : S extends Domain.Query.Any
        ? S
        : never;

/** The rows a query spec answers: its `entries`, else its query's entries. */
type SpecEntryOf<S> = S extends Entries<infer _Q, infer Entry> ? Entry : EntryOf<QueryOf<S>>;

type CommandOf<S> = S extends { readonly command: infer C extends Domain.Command.Any }
  ? C
  : S extends Domain.Command.Any
    ? S
    : never;

/** What a command spec declares: a bare command declares neither `key` nor `target`. */
type DeclaresOf<S> = S extends { readonly "~declares": infer D extends Declares<boolean, boolean> }
  ? D
  : Declares<false, false>;

/** The row key field of an entity. */
type KeyFieldOf<R extends Rows.Any> = R["rows"]["key"];

/** Whether a command's input has a string field named like the row key. */
type HasKeyField<R extends Rows.Any, C extends Domain.Command.Any> =
  KeyFieldOf<R> extends keyof CommandInput<C>
    ? [CommandInput<C>[KeyFieldOf<R>]] extends [string]
      ? true
      : false
    : false;

/**
 * Each command must find its row key (an input field named like the row key, or `key`) and its
 * target (the entity's `target`, when its type is the command's target type, or `target`).
 */
type CommandCheck<R extends Rows.Any, S> = (DeclaresOf<S>["key"] extends true
  ? unknown
  : HasKeyField<R, CommandOf<S>> extends true
    ? unknown
    : {
        readonly "the command's input has no field named like the row key: declare `key`": KeyFieldOf<R>;
      }) &
  (DeclaresOf<S>["target"] extends true
    ? unknown
    : [R["rows"]["~target"]] extends [TargetOf<CommandOf<S>>]
      ? unknown
      : {
          readonly "the Rows entity's target is not this command's target type: declare `target`": TargetOf<
            CommandOf<S>
          >;
        });

type CommandChecks<R extends Rows.Any, Commands> = {
  readonly [K in keyof Commands]: CommandCheck<R, Commands[K]>;
};

/** The errors a subset collection can fail with: its query's and its feed's. */
export type SubsetError<R extends Rows.Any, Q extends Domain.Query.Any> =
  | Domain.Api.QueryError<Q>
  | Rows.FeedError<R>;

/** The row type of a subset: the entity's row, carrying the errors it can fail with. */
export type SubsetRow<R extends Rows.Any, Q extends Domain.Query.Any> = Marked<
  Rows.RowOf<R>,
  SubsetError<R, Q>
>;

/** A subset accessor: one collection per input, all fed by the entity's shared feed. */
export type Subsets<R extends Rows.Any, Q extends Domain.Query.Any> = (
  ...args: Args<Q>
) => Source<SubsetRow<R, Q>>;

/** Each query's entries must be the entity's rows. */
type Checks<R extends Rows.Any, Queries> = {
  readonly [K in keyof Queries]: [SpecEntryOf<Queries[K]>] extends [Rows.RowOf<R>]
    ? unknown
    : { readonly "query entries are not this entity's rows": K };
}[keyof Queries];

/** A declared entity: one subset accessor per query, one command per command. */
export type Collection<R extends Rows.Any, Queries, Commands> = {
  readonly [K in keyof Queries]: Subsets<R, QueryOf<Queries[K]>>;
} & {
  readonly [K in keyof Commands]: Commands[K] extends Keyed<infer C, "updates", boolean, boolean>
    ? Paced<C>
    : Commands[K] extends Inserts<infer C, object, boolean>
      ? Command<C, {}, Created>
      : Command<CommandOf<Commands[K]>>;
};

/** A stable JSON text of an input: object keys sorted, so equal inputs give equal ids. */
export const stable = (value: Input | Page): string =>
  JSON.stringify(value, (_key, inner) => {
    if (inner === null || Array.isArray(inner) || !Predicate.isObject(inner)) return inner;

    return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)));
  });

/** The key of a row of an entity. */
const keyOf = (entity: Rows.Any) => (row: Row) => keyIn(entity.rows.key, row);

/** A query spec's query, membership rule and row reader. */
const readerOf = (spec: QuerySpec): Pick<Spec, "query" | "rule" | "select"> => {
  if (spec instanceof Membership)
    return {
      query: spec.query,
      // SAFETY: the rule reads this query's rows and input.
      rule: Option.some(spec.rule as (row: Row, input: Input) => boolean),
      select: Option.none(),
    };

  if (spec instanceof Entries)
    return {
      query: spec.query,
      // SAFETY: as above.
      rule: spec.rule as Option.Option<(row: Row, input: Input) => boolean>,
      // SAFETY: `select` reads this query's answers, decoded by its schema.
      select: Option.some(spec.select as (answer: Answer) => ReadonlyArray<Row>),
    };

  return { query: spec, rule: Option.none(), select: Option.none() };
};

/** A subset's descriptor: materialised per client, synced by a `Subset` run. */
const subset = (spec: Spec, id: string) =>
  collectionOptions(id, (db: DbClient) => {
    const connection = connectionOf(db);

    const sync: SyncConfig<Row, string> = {
      sync: (params) => new Subset(connection, spec, params).start(),
      rowUpdateMode: "full",
    };

    return {
      id,
      getKey: keyOf(spec.entity),
      gcTime: connection.gcTime,
      sync,
    };
  });

/** The fields of a command's input. */
const fieldsOf = (command: Domain.Command.Any) => {
  const declared = Predicate.hasProperty(command, "fields") ? command.fields : {};

  return Object.keys(Predicate.isObject(declared) ? declared : {}).filter(
    (name) => name !== "_tag",
  );
};

/** Runs each edit on the subsets that show the row; returns how many edits it made. */
const each = (subsets: ReadonlyArray<Subset>, id: string, edit: (subset: Subset) => void) => {
  let edits = 0;

  for (const subset of subsets)
    if (subset.collection.has(id)) {
      edit(subset);
      edits += 1;
    }

  return edits;
};

/** How an entity command finds its row key and target: declared, else from the input and entity. */
const resolver =
  (entity: Rows.Any, declared: Resolved, fallback: (input: Input) => string): Edit["resolve"] =>
  (input, scope, known) => {
    const key = Option.getOrElse(known, () =>
      Option.match(declared.key, { onSome: (read) => read(input), onNone: () => fallback(input) }),
    );

    const target = Option.match(declared.target, {
      onSome: (of) => of(input, scope, key),
      onNone: () => entity.rows.target(key, scope),
    });

    return { key, target, input };
  };

/** The row key in an input's field named like it; a missing field is a declaration bug. */
const fieldOf = (field: string, command: Domain.Command.Any) => (input: Input) => {
  if (Predicate.hasProperty(input, field) && Predicate.isString(input[field])) return input[field];

  throw new Error(`${command.tag}: the input has no ${field}; declare \`key\``);
};

/** A command spec's Domain command and its declared addressing (none for a bare command). */
const declaredOf = (spec: CommandSpec<Row>) => {
  if (
    spec instanceof Inserts ||
    spec instanceof Keyed ||
    spec instanceof Edits ||
    spec instanceof Sends
  )
    return { command: spec.command, declared: spec.addressing };

  const declared: Resolved = { key: Option.none(), target: Option.none() };

  return { command: spec, declared };
};

/** How a declared command addresses and edits the rows of an entity. */
const editOf = (entity: Rows.Any, spec: CommandSpec<Row>): Edit => {
  const field = entity.rows.key;
  const key = keyOf(entity);
  const { command, declared } = declaredOf(spec);
  const resolve = resolver(entity, declared, fieldOf(field, command));
  const base = { entity: Option.some(entity), paced: Option.none(), resolve };

  if (spec instanceof Inserts)
    return {
      ...base,
      resolve: resolver(entity, declared, () => crypto.randomUUID()),
      apply: (subsets, call) => {
        // SAFETY: a call's input is this command's input.
        const row = spec.pending(call.input as never, call.key);
        let edits = 0;

        for (const subset of subsets)
          if (subset.accepts(row) && !subset.collection.has(key(row))) {
            subset.collection.insert(row);
            edits += 1;
          }

        return edits;
      },
    };

  if (spec instanceof Edits)
    return {
      ...base,
      apply: (subsets, call) =>
        each(subsets, call.key, (subset) =>
          subset.collection.update(call.key, (draft) =>
            // SAFETY: a call's input is this command's input; the draft is this row.
            spec.change(draft as never, call.input as never),
          ),
        ),
    };

  if (spec instanceof Keyed) {
    if (spec.kind === "deletes")
      return {
        ...base,
        apply: (subsets, call) =>
          each(subsets, call.key, (subset) => subset.collection.delete(call.key)),
      };

    const names = fieldsOf(spec.command);

    const inputOf = Option.getOrElse(
      spec.values.input,
      () => (row: Row) =>
        Object.fromEntries(Object.entries(row).filter(([name]) => names.includes(name))),
    );

    const valuesOf = Option.getOrElse(spec.values.fields, () => (input: Input) => input);

    return {
      ...base,
      paced: Option.some(inputOf),
      apply: (subsets, call) =>
        each(subsets, call.key, (subset) =>
          subset.collection.update(call.key, (draft) => {
            // Only fields the row has are replaced; the key stays.
            const fields = Object.entries(valuesOf(call.input)).filter(
              ([name]) => name !== field && name in draft,
            );

            Object.assign(draft, Object.fromEntries(fields));
          }),
        ),
    };
  }

  return { ...base, apply: () => 0 };
};

/**
 * Declares an entity: a subset accessor per query and a command per command, at module level.
 * `customers.list(input)` is a collection descriptor for stock `useLiveQuery`; every subset of the
 * entity in one client follows the entity's one feed. Commands return TanStack DB transactions.
 */
export const collection = <
  R extends Rows.Any,
  const Queries extends Readonly<Record<string, QuerySpec>>,
  const Commands extends Readonly<Record<string, CommandSpec<Rows.RowOf<R>>>> = {},
>(
  rows: R,
  declaration: {
    readonly queries: Queries;
    readonly commands?: Commands & CommandChecks<R, Commands>;
  } & Checks<R, Queries>,
): Collection<R, Queries, Commands> => {
  const queries = Object.entries(declaration.queries).map(([name, spec]) => {
    const { query, rule, select } = readerOf(spec);

    const accessor = (input: Input = {}, page: Page = {}) =>
      subset(
        { entity: rows, query, input, page, rule, select },
        `${rows.entityName}/${query.queryName}:${stable(input)}:${stable(page)}`,
      );

    return [name, accessor] as const;
  });

  const commands = Object.entries(declaration.commands ?? {}).map(([name, spec]) => {
    return [name, make(declaredOf(spec).command, editOf(rows, spec))] as const;
  });

  // SAFETY: one accessor per query and one command per command, under their declared names.
  return Object.fromEntries([...queries, ...commands]) as Collection<R, Queries, Commands>;
};

/** The row of a non-entity query: its one result, carrying the query's errors. */
export type ResultRow<Q extends Domain.Query.Any> = Marked<
  NonNullable<Domain.Query.ResultOf<Q>>,
  Domain.Api.QueryError<Q>
>;

/**
 * A query that is not an entity: one collection per input holding its one result (none for
 * `null`) under the key `"result"`. It has no feed: it loads once, and `retry` reloads it.
 */
export const query =
  <Q extends Domain.Query.Any>(source: Q) =>
  (...args: Args<Q>): Source<ResultRow<Q>> => {
    const input: Input = args[0] ?? {};
    const page: Page = args[1] ?? {};
    const id = `${source.queryName}:${stable(input)}:${stable(page)}`;

    return collectionOptions(id, (db: DbClient) => {
      const connection = connectionOf(db);

      const load = async (
        params: Parameters<SyncConfig<ResultRow<Q>, string>["sync"]>[0],
        attempt: number,
      ): Promise<void> => {
        const ask = await connection.query(source.queryName);
        const exit = await connection.run(ask(input, page));

        if (Exit.isSuccess(exit)) {
          params.begin({ snapshot: true });

          if (exit.value !== null) {
            // SAFETY: the query's schema decoded its one result.
            const value = exit.value as ResultRow<Q>;

            params.write({ type: "insert", value });
          }

          void params.commit();

          return params.markReady();
        }

        const error = failureOf(source.queryName, exit.cause);
        const delay = connection.retry(error, attempt);

        if (Option.isNone(delay)) return params.fail(error);

        await connection.sleep(delay.value, "retry");

        return load(params, attempt + 1);
      };

      const sync: SyncConfig<ResultRow<Q>, string> = {
        sync: (params) => {
          void load(params, 1);
        },
      };

      const getKey = (_row: ResultRow<Q>) => "result";

      return { id, getKey, gcTime: connection.gcTime, sync };
    });
  };

/** The one target a singleton aggregate's command can address: its target schema's literal. */
type LiteralOf<C extends Domain.Command.Any> = C["target"] extends {
  readonly literal: infer L extends string;
}
  ? L
  : never;

/**
 * The options of `command`. `target` gives the aggregate a call addresses from its input and the
 * client's scope; it is required unless the command's target schema is one literal (a singleton
 * aggregate), which is then the target.
 */
export type CommandOptions<C extends Domain.Command.Any> = [LiteralOf<C>] extends [never]
  ? [options: { readonly target: TargetFn<C> }]
  : [options?: { readonly target?: TargetFn<C> }];

/** The literal a target schema accepts, when it accepts exactly one string. */
const literalOf = (source: Domain.Command.Any): Option.Option<string> => {
  const schema: object = source.target;

  if (Predicate.hasProperty(schema, "literal") && Predicate.isString(schema.literal))
    return Option.some(schema.literal);

  return Option.none();
};

/** A command with no rows to edit: its transaction settles when the command returns. */
export const command = <C extends Domain.Command.Any>(
  source: C,
  ...options: CommandOptions<C>
): Command<C> => {
  const declared = Option.fromUndefinedOr(options[0]?.target);

  const target = Option.match(declared, {
    // SAFETY: the target function was checked against this command's input when declared.
    onSome: (of): ((input: Input, scope: string) => string) => of as never,
    onNone: () =>
      Option.match(literalOf(source), {
        onSome: (literal) => () => literal,
        onNone: () => {
          throw new Error(`${source.tag}: declare \`target\` for HighAlch.command`);
        },
      }),
  });

  return make(source, {
    entity: Option.none(),
    resolve: (input, scope) => ({ key: "", target: target(input, scope), input }),
    apply: () => 0,
    paced: Option.none(),
  });
};

export type { TaggedFailure };
