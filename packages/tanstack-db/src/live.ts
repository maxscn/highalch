import { Data, Option, Predicate } from "effect";
import { findProblems, type HealthNode } from "@tanstack/db";
import { Defect, type TaggedFailure } from "./state";

/**
 * The type-only key under which a row type carries the errors its collection can fail with. It
 * has no runtime value: no row ever holds it, and `match` reads it from a live query's `data` type.
 */
declare const Errors: unique symbol;

/** A row whose collection can fail with `E`: the row type plus an optional, type-only marker. */
export type Marked<Row, E> = Row & { readonly [Errors]?: E };

/**
 * Declared once by an application, by module augmentation, to name the errors a live query can
 * fail with when its selected fields no longer carry the row marker (a field projection):
 *
 * ```ts
 * declare module "@highalch/tanstack-db" {
 *   interface Register {
 *     readonly errors: HighAlch.ApiErrors<typeof MyApi>;
 *   }
 * }
 * ```
 */
export interface Register {}

/** The application's registered floor, or any tagged failure when none is registered. */
export type Floor = Register extends { readonly errors: infer E extends TaggedFailure }
  ? E
  : TaggedFailure;

// A value that is not a row (e.g. a field typed `Record<string, Json>`) infers `unknown`: no errors.
type RowErrors<T> = T extends { readonly [Errors]?: infer E }
  ? unknown extends E
    ? never
    : Exclude<E, undefined>
  : never;

/** A joined or `select`ed result nests rows under its aliases; each alias keeps its marker. */
type NestedErrors<T> = T extends object
  ? { readonly [K in keyof T]-?: RowErrors<NonNullable<T[K]>> }[keyof T]
  : never;

type ItemErrors<T> = RowErrors<T> | NestedErrors<T>;

type DataErrors<D> = D extends ReadonlyArray<infer Item> ? ItemErrors<Item> : ItemErrors<D>;

/**
 * The errors a live query's result can fail with, recovered from its `data` type: the union of
 * the markers of every row it reads, or the registered floor when a projection dropped them.
 */
export type ErrorsOf<D> = [DataErrors<D>] extends [never] ? Floor : DataErrors<D>;

/** What `match` reads from a stock `useLiveQuery` result. */
export type LiveResult = {
  readonly data: unknown;
  readonly status: string;
  readonly isEnabled: boolean;
  readonly isReady: boolean;
  readonly isLoadingError: boolean;
  readonly isCrashed: boolean;
  readonly health: HealthNode | undefined;
  readonly collection: { readonly reload: () => Promise<void> } | undefined;
};

/**
 * A live query's own states. `Loading`: the first load runs, nothing to show. `Retrying`: the data
 * was ready and a source lost its sync; it is trying again after `error` (`attempt` is the attempt
 * now running, so the first retry is 2), and `data` is what was last loaded. `Ready`: `data` is
 * current; `feed` is the error that stopped a source's live updates for good, if any. `Missing`:
 * a single-result query (`findOne`) is ready and found no row. `Disabled`: the query function
 * returned no query.
 */
export type Live<D, E> = Data.TaggedEnum<{
  Loading: {};
  Retrying: { readonly error: E; readonly attempt: number; readonly data: D };
  Ready: { readonly data: D; readonly feed: Option.Option<E>; readonly retry: () => void };
  Missing: {};
  Disabled: {};
}>;

export interface LiveDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: Live<this["A"], this["B"]>;
}

const states = Data.taggedEnum<LiveDefinition>();

/** The constructors of a live query's own states (the story kit's view helpers use them). */
export const Live = states;

/** What every handler of a live query's `match` receives besides its state. */
export type Controls = {
  /** Reloads the live query and every source whose load failed. */
  readonly retry: () => void;
};

type Single<D> = [Exclude<D, undefined>] extends [ReadonlyArray<unknown>] ? never : "Missing";

type Off<V extends LiveResult> = V["isEnabled"] extends true ? never : "Disabled";

type Shown<V extends LiveResult> = Exclude<V["data"], undefined>;

/** Every state a stock live query result can be in, with its errors from its `data` type. */
export type LiveState<V extends LiveResult> =
  | Data.TaggedEnum.Value<Live<Shown<V>, ErrorsOf<V["data"]>>, "Loading" | "Retrying" | "Ready">
  | Data.TaggedEnum.Value<Live<Shown<V>, ErrorsOf<V["data"]>>, Single<V["data"]> | Off<V>>
  | ErrorsOf<V["data"]>;

const none = () => {};

/** The stock live query result each `Loading` state `fromLive` built was read from. */
const loads = new WeakMap<object, LiveResult>();

/** What `Suspend` uses of a stock live query collection (a TanStack DB `Collection`). */
type Pinnable = {
  readonly status: string;
  readonly subscriberCount: number;
  readonly subscribeChanges: (
    callback: () => void,
    options: { readonly includeInitialState: boolean },
  ) => { readonly unsubscribe: () => void };
  readonly on: (
    event: "status:change" | "subscribers:change",
    callback: (event: { readonly status?: string; readonly subscriberCount?: number }) => void,
  ) => () => void;
};

const pinnable = (collection: unknown): collection is Pinnable =>
  Predicate.hasProperty(collection, "subscribeChanges") &&
  Predicate.hasProperty(collection, "subscriberCount") &&
  Predicate.hasProperty(collection, "on") &&
  Predicate.hasProperty(collection, "status");

/** Whether a collection's first load still runs: not yet ready, failed, crashed or cleaned up. */
const loading = (status: string) => status === "idle" || status === "loading";

/**
 * How long a settled read keeps its collection observed for a retry that has not subscribed yet
 * (TanStack DB's own suspense `gcTime`). A reader that commits and subscribes ends it earlier.
 */
const linger = 5_000;

/** A pending read: the promise its suspended renders throw, and the collection it observes. */
type Wait = { readonly promise: Promise<void>; readonly collection: Pinnable };

/**
 * Observes a loading live query collection until its first load ends (ready, a typed rejection,
 * a crash or a cleanup), then resolves. A suspended render never commits its `useLiveQuery`
 * subscription, so without this observer nothing would load its sources. The promise never
 * rejects: the retried render reads how the load ended and `match` dispatches it. The observer
 * stays until a committed reader subscribes, the collection is cleaned up, or `linger` passes,
 * so a retry that reuses this collection (an input change) finds it loaded.
 */
const pin = (collection: Pinnable): Promise<void> =>
  new Promise<void>((resolve) => {
    let loaded = false;
    let released = false;
    let subscription: { readonly unsubscribe: () => void } | undefined;
    const stops: Array<() => void> = [];

    const release = () => {
      if (released) return;

      released = true;

      for (const stop of stops.splice(0)) stop();

      subscription?.unsubscribe();
    };

    const settle = () => {
      if (loaded) return;

      loaded = true;
      resolve();

      if (collection.status === "cleaned-up" || collection.subscriberCount > 1) return release();

      const timer = setTimeout(release, linger);

      stops.push(() => clearTimeout(timer));
    };

    stops.push(
      collection.on("status:change", ({ status = "" }) => {
        if (status === "cleaned-up") release();

        if (!loading(status)) settle();
      }),
      collection.on("subscribers:change", ({ subscriberCount = 0 }) => {
        if (loaded && subscriberCount > 1) release();
      }),
    );

    // Subscribing starts the load; it may end synchronously, before the subscription is returned.
    subscription = collection.subscribeChanges(none, { includeInitialState: true });

    if (released) subscription.unsubscribe();
    else if (!loading(collection.status)) settle();
  });

/** The load each collection's observer waits for, while it waits. */
const observed = new WeakMap<Pinnable, Promise<void>>();

/** Observes `collection` (once while it loads); resolves when its first load ends. */
const observe = (collection: Pinnable) => {
  const known = observed.get(collection);

  if (known) return known;

  const promise = pin(collection);

  if (loading(collection.status)) {
    observed.set(collection, promise);
    void promise.then(() => observed.delete(collection));
  }

  return promise;
};

/** A source collection of a live query: the object its client materialised, and its id. */
type Source = { readonly id: string };

const isSource = (collection: unknown): collection is Source =>
  Predicate.hasProperty(collection, "id") && Predicate.isString(collection.id);

/** A source as TanStack DB's live query builder lists it: `{ id, alias, collection }`. */
const collectionOf = (source: unknown): ReadonlyArray<Source> => {
  if (!Predicate.hasProperty(source, "collection") || !isSource(source.collection)) return [];

  return [source.collection];
};

/**
 * The source collections a live query collection reads: the objects its client materialised.
 * TanStack DB 1.0 exposes them only on the live query's builder, under its internal
 * `liveQueryInternal` utils key; a version without it gives none, and a read is then not shared.
 */
const sourcesOf = (collection: Pinnable): ReadonlyArray<Source> => {
  const config: unknown = Reflect.get(collection, "config");
  const utils: unknown = Predicate.hasProperty(config, "utils") && config.utils;

  if (!Predicate.isObject(utils)) return [];

  const key = Object.getOwnPropertySymbols(utils).find(
    (symbol) => symbol.description === "liveQueryInternal",
  );
  const internal: unknown = key && Reflect.get(utils, key);

  if (!Predicate.hasProperty(internal, "getBuilder") || !Predicate.isFunction(internal.getBuilder))
    return [];

  const builder: unknown = internal.getBuilder();

  if (
    !Predicate.hasProperty(builder, "healthSources") ||
    !Predicate.isFunction(builder.healthSources)
  )
    return [];

  const sources: unknown = builder.healthSources();

  if (!Array.isArray(sources)) return [];

  return sources.flatMap(collectionOf);
};

/** One step of the shared reads: the reads of exactly the sources on the path to it. */
type Node = { readonly next: WeakMap<object, Node>; wait: Wait | undefined };

/**
 * The pending reads shared between renders, by the exact source collection objects they read:
 * a path of `WeakMap`s, one step per source (in id order). The objects belong to one client;
 * two clients materialise the same declaration under the same id, so only the objects tell
 * their reads apart. A render that suspends is discarded with its hooks, and a retry of a first
 * mount builds a new live query collection over the same source objects: it finds the read this
 * way. An entry leaves when its load ends.
 */
const shared: Node = { next: new WeakMap(), wait: undefined };

const step = (node: Node, source: object): Node => {
  const known = node.next.get(source);

  if (known) return known;

  const created: Node = { next: new WeakMap(), wait: undefined };

  node.next.set(source, created);

  return created;
};

/** Where a live query's read is shared: the node of its source objects (none without them). */
const placeOf = (collection: Pinnable) => {
  const sources = [...new Set(sourcesOf(collection))].sort((a, b) => a.id.localeCompare(b.id));

  return Option.map(
    Option.liftPredicate(sources, (found) => found.length > 0),
    (found) => found.reduce<Node>(step, shared),
  );
};

/**
 * The stable promise a render suspended on `result`'s first load throws. It shares a pending
 * read only with live queries over the same source objects of the same client, whose observer
 * already loads exactly those sources; otherwise it observes the render's own collection.
 */
const whenLoaded = (result: LiveResult): Promise<void> => {
  const collection = result.collection;

  if (!pinnable(collection))
    throw new Error("HighAlch.Suspend needs a stock useLiveQuery result with its collection");

  return Option.match(placeOf(collection), {
    onNone: () => observe(collection),
    onSome: (node) => {
      const known = node.wait;

      if (known && loading(known.collection.status)) return known.promise;

      const promise = observe(collection);

      if (loading(collection.status)) {
        const wait = { promise, collection };

        node.wait = wait;
        void promise.then(() => {
          if (node.wait === wait) node.wait = undefined;
        });
      }

      return promise;
    },
  });
};

/**
 * The `Loading` handler that suspends: `match(res).on({ Loading: HighAlch.Suspend, ... })` throws
 * a promise to the nearest `<Suspense>`. The promise is shared by every render waiting on the same
 * source collections of one client and resolves (never rejects) when the first load ends for any reason; the retried render
 * then matches `Ready`, a typed error or `Missing` as usual, and a defect still throws.
 */
export const Suspend = (state: Data.TaggedEnum.Value<Live<unknown, unknown>, "Loading">): never => {
  const result = loads.get(state);

  if (!result)
    throw new Error(
      "HighAlch.Suspend handles only the Loading state of match(res) over a stock useLiveQuery result",
    );

  throw whenLoaded(result);
};

/** A problem's original value when it is a typed failure; a defect or untyped value is thrown. */
const typed = (cause: unknown): TaggedFailure => {
  if (cause instanceof Defect || !Predicate.hasProperty(cause, "_tag")) throw cause;

  // SAFETY: `hasProperty` established a `_tag`; every typed failure of a collection is tagged.
  return cause as TaggedFailure;
};

const problems = (health: HealthNode | undefined) => (health ? findProblems(health) : []);

/** A live query result as one state, and the controls every handler receives. */
export const fromLive = (result: LiveResult) => {
  const retry = () => void result.collection?.reload().catch(none);
  const controls: Controls = { retry };
  const found = problems(result.health);

  if (!result.isEnabled) return { state: states.Disabled(), controls };

  if (result.isCrashed) throw found[0]?.error?.cause ?? new Error("The live query crashed");

  if (result.isLoadingError) {
    const failed = found.find((node) => node.error !== null);

    if (!failed?.error) throw new Error("The live query failed without a recorded error");

    return { state: typed(failed.error.cause), controls };
  }

  if (!result.isReady) {
    const state = states.Loading();

    loads.set(state, result);

    return { state, controls };
  }

  const retrying = found.find((node) => node.failureReason !== null)?.failureReason;

  if (retrying)
    return {
      state: states.Retrying({
        error: typed(retrying.cause),
        attempt: retrying.errors.length + 1,
        data: result.data,
      }),
      controls,
    };

  const stopped = found.find((node) => node.error !== null)?.error;
  // A defect is thrown here, before `Missing`: an empty single row must not hide it.
  const feed = Option.map(Option.fromNullishOr(stopped), (problem) => typed(problem.cause));

  if (result.data === undefined) return { state: states.Missing(), controls };

  return {
    state: states.Ready({
      data: result.data,
      feed,
      retry,
    }),
    controls,
  };
};
