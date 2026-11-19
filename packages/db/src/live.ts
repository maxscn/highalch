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
 * declare module "@highalch/db" {
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
 * The pending reads, by the ids of the sources they read (or by the collection when it has no
 * health tree). A render that suspends is discarded with its hooks, so a retry of a first mount
 * builds a new live query collection: the sources, held by the client, are what it shares with
 * the render it replaces. An entry leaves when its load ends.
 */
const waits = new Map<string | object, Wait>();

const sourcesOf = (health: HealthNode): ReadonlyArray<string> =>
  health.sources.flatMap((source) => [source.collectionId, ...sourcesOf(source)]);

/** The key of a pending read: its sources' collection ids. */
const keyOf = (health: HealthNode | undefined) =>
  Option.map(Option.fromNullishOr(health), (node) =>
    [...new Set(sourcesOf(node))].sort().join("\n"),
  );

/**
 * Observes a loading live query collection until its first load ends (ready, a typed rejection,
 * a crash or a cleanup), then resolves. A suspended render never commits its `useLiveQuery`
 * subscription, so without this observer nothing would load its sources. The promise never
 * rejects: the retried render reads how the load ended and `match` dispatches it. The observer
 * stays until a committed reader subscribes, the collection is cleaned up, or `linger` passes,
 * so a retry that reuses this collection (an input change) finds it loaded.
 */
const pin = (collection: Pinnable, done: () => void): Promise<void> =>
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
      done();
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

/** The stable promise a render suspended on `result`'s first load throws. */
const whenLoaded = (result: LiveResult): Promise<void> => {
  const collection = result.collection;

  if (!pinnable(collection))
    throw new Error("HighAlch.Suspend needs a stock useLiveQuery result with its collection");

  const key = Option.getOrElse(keyOf(result.health), (): string | object => collection);
  const known = waits.get(key);

  if (known && loading(known.collection.status)) return known.promise;

  const promise = pin(collection, () => {
    if (waits.get(key)?.collection === collection) waits.delete(key);
  });

  if (loading(collection.status)) waits.set(key, { promise, collection });

  return promise;
};

/**
 * The `Loading` handler that suspends: `match(res).on({ Loading: HighAlch.Suspend, ... })` throws
 * a promise to the nearest `<Suspense>`. The promise is shared by every render waiting on the same
 * sources and resolves (never rejects) when the first load ends for any reason; the retried render
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

  if (result.data === undefined) return { state: states.Missing(), controls };

  const stopped = found.find((node) => node.error !== null)?.error;

  return {
    state: states.Ready({
      data: result.data,
      feed: Option.map(Option.fromNullishOr(stopped), (problem) => typed(problem.cause)),
      retry,
    }),
    controls,
  };
};
