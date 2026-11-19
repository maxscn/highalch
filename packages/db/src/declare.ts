import type * as Domain from "@alchemy.run/domain";
import {
  collectionOptions,
  type CollectionOptions,
  type DbClient,
  type NonSingleResult,
  type SyncConfig,
} from "@tanstack/db";
import { Cause, Effect, Exit, Option, Predicate, Scope } from "effect";
import type { Marked } from "./live";
import { Defect, type TaggedFailure } from "./state";
import { closedClientError, connectionOf, failureOf, read } from "./client";
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
export type EntryOf<Q extends Domain.Query.Any> = EntryIn<NonNullable<Domain.Query.ResultOf<Q>>>;

/** The entry of a non-null answer: an answer that may be `null` holds the same entries. */
type EntryIn<A> =
  A extends Domain.Query.Page<infer Entry>
    ? Entry
    : A extends ReadonlyArray<infer Entry>
      ? Entry
      : A;

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

type Select<Q extends Domain.Query.Any, Entry> = (
  answer: NonNullable<Domain.Query.ResultOf<Q>>,
) => ReadonlyArray<Entry>;

type Rule<Q extends Domain.Query.Any, Entry> = (row: Entry, input: QueryInput<Q>) => boolean;

const ReadOptions = Symbol("HighAlch.read");

/** The callbacks' parameter types are checked by the builder and erased here for storage. */
type ReadOptions<Q extends Domain.Query.Any, Entry> = {
  readonly query: Q;
  readonly select?: (answer: never) => ReadonlyArray<Entry>;
  readonly rule?: (row: never, input: never) => boolean;
  /** A distinct declaration for duplicate checking, with the same subset descriptor. */
  readonly single?: boolean;
};

type ReadDeclaration<Q extends Domain.Query.Any, Entry> = {
  readonly [ReadOptions]: ReadOptions<Q, Entry>;
};

/** Marks a declaration whose rule reads rows, so `collection` checks what the rule may read. */
const Ruled: unique symbol = Symbol("@highalch/db/read/ruled");

/**
 * A declaration with a rule that reads rows (`where`, `one`). The feed gives the rule the
 * entity's own rows, so the rule may read only what those rows have.
 */
type RuledDeclaration<Q extends Domain.Query.Any, Entry> = ReadDeclaration<Q, Entry> & {
  readonly [Ruled]: true;
};

/** Which optional facets have already been applied while the query decides membership. */
type ReadFacets = { readonly rows?: true };

type ReadBuilder<Q extends Domain.Query.Any, Entry, Used extends ReadFacets> = ReadDeclaration<
  Q,
  Entry
> & {
  /** Gives a many-row subset a membership rule that places feed rows. */
  where(rule: Rule<Q, Entry>): RuledDeclaration<Q, Entry>;
  /** Gives a single-row subset a membership rule. Use `.findOne()` to read `Missing`. */
  one(rule: Rule<Q, Entry>): RuledDeclaration<Q, Entry>;
} & (Used["rows"] extends true
    ? unknown
    : {
        /** Selects the rows from a wrapped answer, such as `{ Items, Count }`. */
        rows<Selected>(
          select: Select<Q, Selected>,
        ): ReadBuilder<Q, Selected, Used & { readonly rows: true }>;
      }) &
  (true extends NonNullable<Q["definition"]["paged"]>
    ? unknown
    : {
        /** Includes every row in the client's scope. */
        all(): ReadDeclaration<Q, Entry>;
      });

const includesAll = () => true;

const buildRead = <Q extends Domain.Query.Any, Entry, const Used extends ReadFacets>(
  options: ReadOptions<Q, Entry>,
  used: Used,
): ReadBuilder<Q, Entry, Used> => {
  const { query } = options;
  const withRule = (rule: Rule<Q, Entry>, single: boolean): RuledDeclaration<Q, Entry> => ({
    [ReadOptions]: { ...options, rule, single },
    [Ruled]: true,
  });

  const builder = {
    [ReadOptions]: options,
    where: (rule: Rule<Q, Entry>) => withRule(rule, false),
    one: (rule: Rule<Q, Entry>) => withRule(rule, true),
    all: () => {
      if (query.definition.paged)
        throw new Error(`HighAlch.all cannot declare paged query ${query.queryName}`);

      return withRule(includesAll, false);
    },
    ...(!used.rows && {
      rows: <Selected>(select: Select<Q, Selected>) =>
        buildRead({ ...options, select }, { ...used, rows: true }),
    }),
  };

  // SAFETY: `used` controls which methods are attached. The type hides `all` for paged queries;
  // its runtime guard also catches calls from JavaScript or through casts.
  return builder as ReadBuilder<Q, Entry, Used>;
};

/** Declares an entity read. Until a membership rule is supplied, the query decides membership. */
const readBuilder = <Q extends Domain.Query.Any>(query: Q): ReadBuilder<Q, EntryOf<Q>, {}> =>
  buildRead({ query }, {});

export { readBuilder as read };

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
  /**
   * The input a paced call sends for a merged row; by default the row's fields that are inputs.
   * `row` holds the row's key and only the fields the merged calls changed.
   */
  readonly input?: (row: Partial<P>) => CommandInput<C>;
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

/** What `queries` may hold: a bare query or a declaration from `read`. */
export type QuerySpec = Domain.Query.Any | ReadDeclaration<Domain.Query.Any, unknown>;

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
  S extends ReadDeclaration<infer Q, unknown> ? Q : S extends Domain.Query.Any ? S : never;

type SpecEntryOf<S> =
  S extends ReadDeclaration<Domain.Query.Any, infer Entry>
    ? Entry
    : S extends Domain.Query.Any
      ? EntryOf<S>
      : never;

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

/**
 * Each query's entries must be the entity's rows, and a rule may read only what the entity's rows
 * have, since the feed gives it those rows and not the query's entries. Report a mismatch on that
 * query.
 */
type Checks<R extends Rows.Any, Queries> = {
  readonly [K in keyof Queries]: [SpecEntryOf<Queries[K]>] extends [Rows.RowOf<R>]
    ? Queries[K] extends { readonly [Ruled]: true }
      ? [Rows.RowOf<R>] extends [SpecEntryOf<Queries[K]>]
        ? unknown
        : { readonly "the rule reads rows the feed does not deliver": Rows.RowOf<R> }
      : unknown
    : { readonly "query entries are not this entity's rows": Rows.RowOf<R> };
};

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

type DeclaredRead = ReadOptions<Domain.Query.Any, unknown>;

/** Bare queries and `read(query)` have the same options. */
const optionsOf = (spec: QuerySpec): DeclaredRead => {
  if (ReadOptions in spec) return spec[ReadOptions];

  return { query: spec };
};

/** The defect a read started on a closing or closed HighAlch client fails with. */
const closedRead = (name: string) => new Defect({ name, cause: Cause.die(closedClientError()) });

/** A subset runs the query, its optional membership rule and its optional row selector. */
const readerOf = ({
  query,
  rule,
  select,
}: DeclaredRead): Pick<Spec, "query" | "rule" | "select"> => ({
  query,
  // SAFETY: the rule reads this query's rows and input.
  rule: Option.fromUndefinedOr(rule as ((row: Row, input: Input) => boolean) | undefined),
  // SAFETY: `select` reads this query's decoded answers and `collection` checked its rows.
  select: Option.fromUndefinedOr(select as ((answer: Answer) => ReadonlyArray<Row>) | undefined),
});

/** A subset's descriptor: materialised per client, synced by a `Subset` run. */
const subset = (spec: Spec, id: string) =>
  collectionOptions(id, (db: DbClient) => {
    const connection = connectionOf(db);

    const sync: SyncConfig<Row, string> = {
      sync: (params) => {
        // A read from a closing or closed client is a bug in the caller: a defect, not a state.
        if (connection.closingOrClosed) return params.fail(closedRead(id));

        return new Subset(connection, spec, params).start();
      },
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

const declarations = new WeakMap<Rows.Any, Map<string, DeclaredRead>>();

const sameDeclaration = (first: DeclaredRead, second: DeclaredRead): boolean =>
  first.query === second.query &&
  first.select === second.select &&
  first.rule === second.rule &&
  first.single === second.single;

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
    readonly queries: Queries & Checks<NoInfer<R>, NoInfer<Queries>>;
    readonly commands?: Commands & CommandChecks<R, Commands>;
  },
): Collection<R, Queries, Commands> => {
  const known = new Map(declarations.get(rows));
  const queries = Object.entries(declaration.queries).map(([name, spec]) => {
    const options = optionsOf(spec);
    const { query } = options;
    const previous = known.get(query.queryName);

    if (previous && !sameDeclaration(previous, options))
      throw new Error(
        `HighAlch.collection: conflicting declarations of query ${query.queryName} for ${rows.entityName}`,
      );

    known.set(query.queryName, options);

    const reader = readerOf(options);

    const accessor = (input: Input = {}, page: Page = {}) =>
      subset(
        { ...reader, entity: rows, input, page },
        `${rows.entityName}/${query.queryName}:${stable(input)}:${stable(page)}`,
      );

    return [name, accessor] as const;
  });

  const commands = Object.entries(declaration.commands ?? {}).map(([name, spec]) => {
    return [name, make(declaredOf(spec).command, editOf(rows, spec))] as const;
  });

  declarations.set(rows, known);

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

      const sync: SyncConfig<ResultRow<Q>, string> = {
        sync: (params) => {
          if (connection.closingOrClosed) return params.fail(closedRead(source.queryName));

          const scope = connection.openScope();
          let stopping = false;
          const ask = connection.query(source.queryName, input, page);

          connection.fork(
            Effect.yieldNow.pipe(
              Effect.andThen(read(source.queryName, ask)),
              Effect.retry(connection.retry),
              Effect.tap((answer) =>
                Effect.sync(() => {
                  params.begin({ snapshot: true });

                  if (answer !== null) {
                    // SAFETY: the query's schema decoded its one result.
                    params.write({ type: "insert", value: answer as ResultRow<Q> });
                  }

                  void params.commit();
                  params.markReady();
                }),
              ),
              Effect.catchCause((cause) => {
                if (stopping && Cause.hasInterruptsOnly(cause)) return Effect.void;

                return Effect.sync(() => params.fail(failureOf(source.queryName, cause)));
              }),
            ),
            scope,
          );

          return () => {
            stopping = true;

            return Effect.runPromise(Scope.close(scope, Exit.void));
          };
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
