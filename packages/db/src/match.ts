import { fromLive, type Controls, type LiveResult, type LiveState } from "./live";
import { ClientClosed, type TaggedFailure } from "./state";

/** Joins the tags of one `anyOf` key. A tag never contains a space, so it cannot occur in a tag. */
const separator = " | ";

type Separator = typeof separator;

/** The key `anyOf` builds from its tags, e.g. `"Loading | Retrying"`. */
export type AnyOf<T extends ReadonlyArray<string>> = T extends readonly [infer Tag extends string]
  ? Tag
  : T extends readonly [infer Tag extends string, ...infer Rest extends ReadonlyArray<string>]
    ? `${Tag}${Separator}${AnyOf<Rest>}`
    : string;

/** The tags a key names: one tag, or every tag of an `anyOf` key. */
type Named<K> = K extends `${infer Tag}${Separator}${infer Rest}` ? Tag | Named<Rest> : K;

type Tags<S extends TaggedFailure> = S["_tag"];

type Branches<K extends string> = Exclude<K, "orElse">;

type Covered<K extends string> = Named<Branches<K>>;

type Case<S extends TaggedFailure, T> = Extract<S, Readonly<Record<"_tag", T>>>;

/** What a branch receives: exactly its states; `orElse` receives every state no branch named. */
type Argument<S extends TaggedFailure, K extends string, P> = P extends "orElse"
  ? Case<S, Exclude<Tags<S>, Covered<K>>>
  : Case<S, Named<P>>;

/**
 * One handler per key. The constraint's `void` result accepts a handler returning anything;
 * `on` reads each handler's actual result type from the handlers it is given. A handler also
 * receives `C`, what the matched value offers every state (a live query's `retry`); a handler
 * may ignore it.
 */
export type Handlers<S extends TaggedFailure, K extends string, C = void> = {
  readonly [P in K]: (state: Argument<S, K, P>, controls: C) => void;
};

type Impossible<S extends TaggedFailure, K extends string> = [
  Exclude<Covered<K>, Tags<S>>,
] extends [never]
  ? unknown
  : { readonly "impossible states": Exclude<Covered<K>, Tags<S>> };

type Twice<K extends string> = {
  [P in Branches<K>]: Named<P> & Covered<Exclude<K, P>>;
}[Branches<K>] extends infer Repeated
  ? [Repeated] extends [never]
    ? unknown
    : { readonly "states named twice": Repeated }
  : never;

type Missing<
  S extends TaggedFailure,
  K extends string,
  Optional extends string,
> = "orElse" extends K
  ? unknown
  : [Exclude<Tags<S>, Covered<K> | Optional>] extends [never]
    ? unknown
    : { readonly "missing states": Exclude<Tags<S>, Covered<K> | Optional> };

/** Every check `on` makes of its handlers; each failing one names its tags in the error. */
export type Checked<
  S extends TaggedFailure,
  K extends string,
  C = void,
  Optional extends string = never,
> = Handlers<S, K, C> & Impossible<S, K> & Twice<K> & Missing<S, K, Optional>;

/**
 * One key for several tags: `[anyOf("Loading", "Retrying")]: () => <Skeleton />`. The key is the
 * tags joined in the given order, so `anyOf("A", "B")` and `anyOf("B", "A")` are different keys
 * for the same states, and naming both in one `on` is a type error (states named twice).
 * `anyOf("A")` is the key `A`.
 */
export const anyOf = <const T extends readonly [string, ...Array<string>]>(...tags: T): AnyOf<T> =>
  // SAFETY: `AnyOf<T>` is exactly the tags of `T` joined by `separator`, in order.
  tags.join(separator) as AnyOf<T>;

/** Runs the handler whose key names the state's tag, else `orElse`. */
const dispatch = <R, C>(
  state: TaggedFailure,
  controls: C,
  handlers: Readonly<Partial<Record<string, (state: TaggedFailure, controls: C) => R>>>,
): R => {
  for (const [key, handler] of Object.entries(handlers))
    if (handler && key !== "orElse" && key.split(separator).includes(state._tag))
      return handler(state, controls);

  const fallback = handlers["orElse"];

  if (!fallback && state instanceof ClientClosed) throw state;
  if (!fallback) throw new Error(`No match branch for ${state._tag}`);

  return fallback(state, controls);
};

/** Runs the handler a tagged value's key names, else `orElse` (a command's `onRejected`). */
export const handle = <S extends TaggedFailure>(
  state: S,
  handlers: Readonly<Partial<Record<string, (state: S) => void>>>,
) =>
  dispatch(
    state,
    undefined,
    // SAFETY: each handler receives the values its key names, as `dispatch` passes them.
    handlers as Readonly<Partial<Record<string, (state: TaggedFailure) => void>>>,
  );

/** What `match` accepts: a tagged state (a command's `result`, say) or a stock `useLiveQuery` result. */
export type Matchable = TaggedFailure | LiveResult;

/** The state of a `Matchable`. */
export type StateOf<V extends Matchable> = V extends TaggedFailure
  ? V
  : V extends LiveResult
    ? LiveState<V>
    : never;

/** What each handler receives besides the state: a live query's controls, else nothing. */
export type ControlsOf<V extends Matchable> = V extends TaggedFailure
  ? void
  : V extends LiveResult
    ? Controls
    : void;

/**
 * Renders one state with a handler per tag. A key is a tag or an `anyOf(...)` key naming
 * several; each handler receives exactly the states its key names. Without `orElse` every required
 * state must be named; `orElse` receives the rest. A tag the state cannot be, or one named twice, is a
 * type error that names it. Returns the union of the handlers' results.
 */
export type Matcher<S extends TaggedFailure, C = void, Optional extends string = never> = {
  readonly on: <const K extends string, H extends Handlers<S, K, C>>(
    handlers: Checked<S, K, C, Optional> & H,
  ) => ReturnType<H[K]>;
};

/** A matched value's state, and what every handler receives besides it. */
type Reading = { readonly state: TaggedFailure; readonly controls: Controls | undefined };

const read = (value: Matchable): Reading => {
  if ("_tag" in value) return { state: value, controls: undefined };

  return fromLive(value);
};

// Keep exhaustive Domain handlers valid while allowing a lifecycle error branch on live reads.
type OptionalOf<V extends Matchable> = V extends LiveResult ? ClientClosed["_tag"] : never;

/**
 * `match(value).on(handlers)`: renders a tagged state or a stock
 * `useLiveQuery` result. A live query result is read once, when `match` is called: its tagged
 * failure is the original error instance, a defect (an untagged failure) is thrown, and every
 * handler receives `{ retry }` as its second argument.
 */
export const match = <V extends Matchable>(
  value: V,
): Matcher<StateOf<V>, ControlsOf<V>, OptionalOf<V>> => {
  const { state, controls } = read(value);

  return {
    // SAFETY: the signature only narrows what `dispatch` accepts: each handler gets exactly the
    // states its key names, which is the state `dispatch` passes it, and returns its own result.
    on: (<R>(
      handlers: Readonly<
        Partial<Record<string, (state: TaggedFailure, controls: Controls | undefined) => R>>
      >,
    ) => dispatch(state, controls, handlers)) as Matcher<
      StateOf<V>,
      ControlsOf<V>,
      OptionalOf<V>
    >["on"],
  };
};
