import * as Domain from "@alchemy.run/domain";
import type * as Aggregate from "@alchemy.run/domain/Aggregate";
import type * as Middleware from "@alchemy.run/domain/Middleware";
import type * as ProjectionModule from "@alchemy.run/domain/Projection";
import type * as Rejection from "@alchemy.run/domain/Rejection";
import type * as ViewModule from "@alchemy.run/domain/View";
import { Data, Effect, Option, Predicate, Schema, type Context, type Layer } from "effect";
// Unused here, but in scope so the emitted declarations of `Feed` and `Projection` (classes
// extending alchemy's) can name these members of their inferred types (TS4023 otherwise).
/* oxlint-disable no-unused-vars */
import type { NodeInspectSymbol } from "effect/Inspectable";
import type * as Unify from "effect/Unify";
/* oxlint-enable no-unused-vars */

/** What a `Rows` handler answers for one source event: one row upserted, or one key removed. */
export type Change<Row> = Data.TaggedEnum<{
  Upserted: { readonly row: Row };
  Removed: { readonly key: string };
}>;

interface ChangeDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Change<this["A"]>;
}

const changes = Data.taggedEnum<ChangeDefinition>();

/** The whole row as it is after the event, inserted or replaced in every subset that shows it. */
export const upserted = <Row>(row: Row): Change<Row> => changes.Upserted({ row });

/** The row with this key is gone; every subset that shows it drops it. */
export const removed = (key: string): Change<never> => changes.Removed({ key });

/** Whether a change removes a row. */
export const isRemoved = changes.$is("Removed");

/** A string Schema: the value that keys one feed, such as an account key. */
export type ScopeSchema = Schema.Top & { readonly Type: string; readonly Encoded: string };

// ---------------------------------------------------------------- the feed (a Domain.Stream)

const cause = Schema.optionalKey(Schema.String);

/**
 * The two entry events of a feed, shared by every entity on it. `entity` names the entity, `row`
 * is the whole row as the entity's row schema encodes it (the reader decodes it with that schema),
 * and `cause` is the command whose change the entry delivers, when the entity names one.
 */
const entriesOf = <const Name extends string>(name: Name) => ({
  Upserted: Domain.Event(`${name}.Upserted`, { entity: Schema.String, row: Schema.Unknown, cause }),
  Removed: Domain.Event(`${name}.Removed`, { entity: Schema.String, key: Schema.String, cause }),
});

/** A feed's declaration: what keys it, and how its reads are guarded. */
export type FeedDefinition<
  Scope extends ScopeSchema,
  Ms extends Middleware.List,
  Rejects extends ReadonlyArray<Rejection.Any>,
> = {
  /** What keys one feed: a string Schema, e.g. an account key. Its projection is keyed by it. */
  readonly scope: Scope;
  /** Middleware that guards reads of the feed, as on any stream. */
  readonly middleware?: Ms;
  /** The rejections a read of the feed may fail with; they reach every collection typed. */
  readonly rejects?: Rejects;
};

/** What a feed carries besides its `Domain.Stream` class: its scope and its two entry events. */
export type FeedMeta = {
  readonly scope: ScopeSchema;
  readonly Upserted: Domain.Event.Any;
  readonly Removed: Domain.Event.Any;
};

/** Any feed: a `Domain.Stream` made by `Feed`, as this package reads it. */
export type AnyFeed = {
  readonly kind: "Stream";
  readonly streamName: string;
  readonly definition: Domain.Stream.Any["definition"];
  readonly feed: FeedMeta;
};

/** The identifier a service class provides under. */
type IdentifierOf<K> = K extends Context.Key<infer I, unknown> ? I : never;

/** The instance type of a rejection class. */
type RejectionOf<Rejects extends ReadonlyArray<Rejection.Any>> = Aggregate.InstanceOf<
  Rejects[number]
>;

/**
 * One `Domain.Stream` per scope (e.g. per account) that carries the row changes of several
 * entities: `<name>.Upserted { entity, row }` and `<name>.Removed { entity, key }`, written by the
 * one projection `Projection` builds from its entities. List it in the model's `streams` and serve
 * it in the Api like any stream; a guarded feed (`middleware` or `rejects`) needs its Layer, which
 * `readers` builds.
 */
export const Feed = <
  const Name extends string,
  Scope extends ScopeSchema,
  const Ms extends Middleware.List = readonly [],
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
>(
  name: Name,
  definition: FeedDefinition<Scope, Ms, Rejects>,
) => {
  const { Upserted, Removed } = entriesOf(name);

  const Stream = Domain.Stream(name, {
    key: definition.scope,
    entries: [Upserted, Removed],
    middleware: definition.middleware,
    rejects: definition.rejects,
  });

  return class extends Stream {
    static readonly feed: FeedMeta = { scope: definition.scope, Upserted, Removed };

    /**
     * The feed's Layer for "a reader reads only its own scope": `scope` is the reader's scope
     * (read from what the feed's middleware provides), and a read of any other scope fails with
     * `reject()`. Judged on every read and on every entry a reader receives.
     */
    static readers(options: {
      readonly scope: Effect.Effect<Scope["Type"], RejectionOf<Rejects>, Middleware.Provides<Ms>>;
      readonly reject: () => RejectionOf<Rejects>;
    }): Layer.Layer<IdentifierOf<(typeof Stream)["Validator"]>> {
      const validate = (request: { readonly key: unknown }) =>
        Effect.flatMap(options.scope, (own) =>
          Effect.suspend(() => {
            if (own === request.key) return Effect.void;

            return Effect.fail(options.reject());
          }),
        );

      // SAFETY: a Schema-keyed stream's key is the scope value; `validate` reads only the key.
      return Stream.toLayer(Effect.succeed(validate as never)) as never;
    }
  };
};

// ---------------------------------------------------------------- one entity on a feed

/** What one handler of `on` receives besides the event: where it came from. */
export type Source<Input> = Input extends {
  readonly source: infer S;
  readonly state: infer St;
}
  ? {
      readonly source: S;
      readonly state: St;
      readonly envelope: Domain.Aggregate.Envelope;
    }
  : never;

type Answer<Row> = Change<Row> | ReadonlyArray<Change<Row>> | undefined;

/** One handler per source event tag (or source name), mapping the event to row changes. */
export type On<From extends ReadonlyArray<ViewModule.Source>, Row> = {
  readonly [K in ViewModule.HandlerKey<From>]?: (
    event: ViewModule.InputFor<From, K>["event"],
    source: Source<ViewModule.InputFor<From, K>>,
  ) => Answer<Row>;
};

/** The key of a row: its key field's value. */
export type KeyOf<RowSchema extends Schema.Top, KeyField extends keyof RowSchema["Type"]> = Extract<
  RowSchema["Type"][KeyField],
  string
>;

export type RowsDefinition<
  F extends AnyFeed,
  RowSchema extends Schema.Top,
  KeyField extends keyof RowSchema["Type"] & string,
  From extends ReadonlyArray<ViewModule.Source>,
  Target extends string = KeyOf<RowSchema, KeyField>,
> = {
  /** The feed this entity's changes go to (shared with other entities of the same scope). */
  readonly feed: F;
  /** The row schema, declared once: queries, the feed and commands all use this row. */
  readonly row: RowSchema;
  /** The row field holding its key (a string). */
  readonly key: KeyField;
  /** The aggregates or views whose events change rows. */
  readonly from: From;
  /** The feed (scope) an event belongs to, or `undefined` to leave it out of every feed. */
  readonly scope: (input: ViewModule.Inputs<From>) => F["feed"]["scope"]["Type"] | undefined;
  /**
   * The aggregate a row's commands address: the target of a command, from the row key and the
   * client's scope (for example `(key, scope) => JSON.stringify([scope, key])`). Defaults to the
   * row key itself. Every command of the entity's collection uses it, unless the command declares
   * its own `target`.
   */
  readonly target?: (key: KeyOf<RowSchema, KeyField>, scope: F["feed"]["scope"]["Type"]) => Target;
  /**
   * Each source event's row changes: `HighAlch.upserted(row)`, `HighAlch.removed(key)`, several
   * of them, or nothing. The feed keeps no row, so the event (or a source view's state) must carry
   * the whole row after it.
   */
  readonly on: On<From, RowSchema["Type"]>;
  /**
   * The command whose change a source event delivers, when that is not the command that recorded
   * the event: for example a policy that settles a command's write after it persisted, under its
   * own command id. Answer `undefined` for an event recorded by the command it delivers. Declaring
   * it means changes can arrive after the command's receipt, so the entity's commands settle only
   * when the feed delivers their change (or as `Unconfirmed` after the client's `settleTimeout`),
   * never merely because the feed passed the command's own receipt.
   */
  readonly cause?: (event: ViewModule.Inputs<From>["event"]) => string | undefined;
};

/** What a `Rows` entity carries for its collections: its row, key field, target and feed. */
export type Meta<RowSchema extends Schema.Top, KeyField extends string, Target extends string> = {
  readonly row: RowSchema;
  readonly key: KeyField;
  /** The target of a command addressing the row with this key, in the scope of a client. */
  readonly target: (key: string, scope: string) => string;
  /** Whether changes can arrive after their command's receipt (the entity declares `cause`). */
  readonly deferred: boolean;
  /** Type-level only: the row. */
  readonly "~row": RowSchema["Type"];
  /** Type-level only: what `target` returns, checked against each command's target. */
  readonly "~target": Target;
};

/** A source event or source value, which the projection hands to `on` untouched. */
interface Payload {}

/** One input of the feed's projection, as an entity reads it. */
type Input = {
  readonly event: Payload;
  readonly source: Payload;
  /** A view source's state after the event (`null` when deleted); nothing for an aggregate. */
  readonly state: unknown;
  readonly envelope: Payload;
};

/** What the feed's projection runs for one entity. */
export type Writer = {
  readonly from: ReadonlyArray<ViewModule.Source>;
  /** Whether the entity maps the event `tag` of the source named `source`. */
  readonly handles: (source: string, tag: string) => boolean;
  /** The scope an input belongs to, or `undefined`. */
  readonly scope: (source: string, input: Input) => string | undefined;
  /** The feed entries an input produces, each naming the entity. */
  readonly entries: (
    source: string,
    input: Input,
  ) => Effect.Effect<ReadonlyArray<Aggregate.InstanceOf<Domain.Event.Any>>>;
};

/** The name of a source. */
export const nameOf = (source: ViewModule.Source): string =>
  Predicate.hasProperty(source, "aggregateName")
    ? String(source.aggregateName)
    : String(source.viewName);

const tagOf = (event: Payload) => (Predicate.hasProperty(event, "_tag") ? String(event._tag) : "");

const list = <A>(answer: A | ReadonlyArray<A> | undefined): ReadonlyArray<A> => {
  if (answer === undefined) return [];

  if (Array.isArray(answer)) return answer;

  // SAFETY: an answer that is not an array is one change.
  const one = answer as A;

  return [one];
};

/**
 * One entity on a feed: its row schema and key field, the sources whose events change its rows,
 * the feed each event belongs to (`scope`), and the changes `on` maps each event to. Its changes
 * are written by the feed's one projection (`Projection`), which lists it; collections over it
 * read the feed (`HighAlch.collection(CustomerRows, …)`).
 */
export const Rows = <
  const Name extends string,
  F extends AnyFeed,
  RowSchema extends Schema.Top,
  const KeyField extends keyof RowSchema["Type"] & string,
  const From extends ReadonlyArray<ViewModule.Source>,
  Target extends string = KeyOf<RowSchema, KeyField>,
>(
  name: Name,
  definition: RowsDefinition<F, RowSchema, KeyField, From, Target>,
) => {
  const feed = definition.feed.feed;

  // SAFETY: `on` is keyed by event tag or source name; the projection hands every handler the
  // event it names, with its source.
  const on = definition.on as Readonly<
    Record<
      string,
      ((event: Payload, source: Omit<Input, "event">) => Answer<RowSchema["Type"]>) | undefined
    >
  >;

  /** The handler of an event: by its tag, else by its source's name. */
  const handler = (source: string, tag: string) => on[tag] ?? on[source];

  const sources = new Set(definition.from.map(nameOf));

  /** The `cause` field of the entries an event produces: present only when the entity names one. */
  const causeOf = (event: Payload): { readonly cause?: string } =>
    Option.match(
      Option.flatMap(Option.fromUndefinedOr(definition.cause), (of) =>
        // SAFETY: the projection hands the entity's own source events, which `cause` is typed for.
        Option.fromUndefinedOr(of(event as ViewModule.Inputs<From>["event"])),
      ),
      { onNone: () => ({}), onSome: (command) => ({ cause: command }) },
    );

  const schema: Schema.Top = definition.row;

  // SAFETY: a row schema is a plain codec: decoding and encoding it need no services.
  const encode = Schema.encodeUnknownEffect(schema as Schema.Codec<unknown, unknown>);

  const writer: Writer = {
    from: definition.from,
    handles: (source, tag) => sources.has(source) && handler(source, tag) !== undefined,
    scope: (source, input) =>
      // SAFETY: the projection routes the entity's own source inputs, named by their source.
      definition.scope({ name: source, ...input } as never),
    entries: (source, input) => {
      const caused = causeOf(input.event);

      const answered = list(
        handler(source, tagOf(input.event))?.(input.event, {
          source: input.source,
          state: input.state,
          envelope: input.envelope,
        }),
      );

      return Effect.forEach(answered, (change) =>
        changes.$match(change, {
          // An entry that cannot be encoded is a bug in the entity's `on`: the projection dies.
          Upserted: ({ row }) =>
            Effect.map(
              Effect.orDie(encode(row)),
              (encoded) => new feed.Upserted({ entity: name, row: encoded, ...caused }),
            ),
          Removed: ({ key }) => Effect.succeed(new feed.Removed({ entity: name, key, ...caused })),
        }),
      );
    },
  };

  const target = definition.target;

  const meta: Meta<RowSchema, KeyField, Target> = {
    row: definition.row,
    key: definition.key,
    target: (key, scope) => {
      if (!target) return key;

      // SAFETY: a command's row key is a key of this row, and the scope is the client's.
      return target(key as KeyOf<RowSchema, KeyField>, scope as F["feed"]["scope"]["Type"]);
    },
    deferred: definition.cause !== undefined,
    // SAFETY: type-level fields; nothing reads their values.
    "~row": undefined as never,
    // SAFETY: as above.
    "~target": undefined as never,
  };

  return class {
    static readonly kind = "Rows" as const;
    static readonly entityName: Name = name;
    static readonly feed: F = definition.feed;
    static readonly rows = meta;
    static readonly writer = writer;
  };
};

/** Any `Rows` entity. */
export type Any = {
  readonly kind: "Rows";
  readonly entityName: string;
  readonly feed: AnyFeed;
  readonly rows: {
    readonly row: Schema.Top;
    readonly key: string;
    readonly target: (key: string, scope: string) => string;
    readonly deferred: boolean;
    readonly "~row": object;
    readonly "~target": string;
  };
  readonly writer: Writer;
};

/** The row of a `Rows` entity. */
export type RowOf<R extends Any> = R["rows"]["~row"];

/** The errors reading an entity's feed can fail with: rejections, middleware errors, transport. */
export type FeedError<R extends Any> = Domain.Api.ReadError<R["feed"]["definition"]>;

// ---------------------------------------------------------------- the feed's one writer

/** The events a source produces: an aggregate's, or a view's emitted (or passed-on) events. */
const outputsOf = (source: ViewModule.Source): ReadonlyArray<Domain.Event.Any> => {
  if (Predicate.hasProperty(source, "aggregateName"))
    // SAFETY: an aggregate's definition lists its event classes.
    return (source as Domain.Aggregate.Any).definition.events;

  // SAFETY: a source that is not an aggregate is a view.
  const view = source as Domain.View.Any;
  const emitted = view.definition.events ?? [];

  if (emitted.length > 0) return emitted;

  return view.definition.from.flatMap(outputsOf);
};

/** What the projection uses of the feed's stream host: appending for the input it handles. */
type Appender = {
  readonly append: (
    origin: { readonly key: string },
    ...events: ReadonlyArray<Aggregate.InstanceOf<Domain.Event.Any>>
  ) => Effect.Effect<void>;
};

/** A route of the projection: one entity's inputs from one source. */
type Route = { readonly entity: Any; readonly source: string };

/** The options of the projection's Layer: batching, and a version to replay it again. */
export type ProjectionOptions = ProjectionModule.Options;

/**
 * The one projection that writes a feed, built from the entities on it: it consumes every event
 * an entity maps, routes it to the entity's scope (one route per entity and source), and appends
 * that entity's entries. Adding an entity is one line in `entities`. List it in the model's
 * `projections` and give the model its `layer`.
 *
 * Like every projection it runs at least once per input, in order per scope; a replayed or
 * redelivered input appends nothing twice. Added to a deployment that already has history, it
 * replays that history first (alchemy's backfill).
 */
export const Projection = <
  const Name extends string,
  F extends AnyFeed,
  const Entities extends ReadonlyArray<Any & { readonly feed: F }>,
>(
  name: Name,
  definition: {
    readonly feed: F & Domain.Stream.Any;
    readonly entities: Entities;
    readonly options?: ProjectionOptions;
  },
) => {
  const feed = definition.feed;

  for (const entity of definition.entities)
    if (entity.feed !== feed)
      throw new Error(
        `${entity.entityName} is on ${entity.feed.streamName}, not ${feed.streamName}`,
      );

  const sources = new Map<string, ViewModule.Source>();

  for (const entity of definition.entities)
    for (const source of entity.writer.from) sources.set(nameOf(source), source);

  const routes = new Map<string, Route>();

  const keyOf = Object.fromEntries(
    [...sources.keys()].map((source) => {
      const using = definition.entities.filter((entity) =>
        entity.writer.from.some((each) => nameOf(each) === source),
      );

      const routed = using.map((entity) => {
        const route = `${entity.entityName}/${source}`;

        routes.set(route, { entity, source });

        return [
          route,
          (input: Input) => {
            if (!entity.writer.handles(source, tagOf(input.event))) return undefined;

            return entity.writer.scope(source, input);
          },
        ] as const;
      });

      return [source, Object.fromEntries(routed)] as const;
    }),
  );

  const on = [
    ...new Set(
      [...sources].flatMap(([source, from]) =>
        outputsOf(from).filter((event) =>
          definition.entities.some((entity) => entity.writer.handles(source, event.tag)),
        ),
      ),
    ),
  ];

  const Base = Domain.Projection(name, {
    from: [...sources.values()],
    key: feed.feed.scope,
    // SAFETY: one record of named routes per source name, each answering a scope value or
    // `undefined`, which is what a Schema-keyed projection's `keyOf` accepts.
    keyOf: keyOf as never,
    on,
    // The feed class itself (the model lists that class among its streams).
    writes: [feed],
  });

  const layer = Base.toLayer(
    Effect.gen(function* () {
      const host = yield* feed;

      // SAFETY: a stream's service, provided by the model, is its host, which appends entry
      // events for the input a projection handles.
      const stream = host as Appender;

      return (batch) =>
        Effect.forEach(
          batch,
          (input) =>
            Option.match(Option.fromUndefinedOr(routes.get(input.route ?? "")), {
              onNone: () => Effect.void,
              onSome: ({ entity, source }) =>
                Effect.flatMap(entity.writer.entries(source, input), (entries) =>
                  Effect.suspend(() => {
                    if (entries.length === 0) return Effect.void;

                    return stream.append(input, ...entries);
                  }),
                ),
            }),
          { discard: true },
        );
    }),
    definition.options,
  );

  return class extends Base {
    /**
     * The projection's implementation, for the model's `layer`. It needs only the feed.
     * SAFETY: it requires the feed's stream service, whose identifier is the feed class's.
     */
    static readonly layer = layer as Layer.Layer<
      ProjectionModule.ProjectionKey<Name>,
      never,
      IdentifierOf<F>
    >;

    static readonly entities: Entities = definition.entities;
  };
};
