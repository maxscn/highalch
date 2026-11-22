import type { CollectionStatus, HealthNode, HealthProblem } from "@tanstack/db";
import { Option, Predicate, type Data } from "effect";
import type { ErrorsOf, Live as LiveStates, Source, TaggedFailure } from "@lowalch/tanstack-db";
import { Live as live, Settled as settled } from "@lowalch/tanstack-db/internal";

/**
 * The constructors of every state `match` gives a live query result: `Loading()`,
 * `Retrying({ error, attempt, data })`, `Ready({ data, feed, retry })`, `Missing()`,
 * `Disabled()`. A presentational component that takes a state renders each branch from them.
 */
export const Live = live;

/** The constructors of a command's settled value: `Committed({ reply, stream, version })`, `Unconfirmed(...)`. */
export const Settled = settled;

type States<Row, E> = LiveStates<ReadonlyArray<Row>, E>;

/**
 * The states a view result can be built for: `Live.Loading()`, `Live.Retrying(...)`,
 * `Live.Ready(...)`, or one of the source's typed errors.
 */
export type ViewState<Row, E> =
  | Data.TaggedEnum.Value<States<Row, E>, "Loading" | "Retrying" | "Ready">
  | E;

type Own = "Loading" | "Retrying" | "Ready";

type Of<Row, E, Tag extends Own> = Data.TaggedEnum.Value<States<Row, E>, Tag>;

/** Whether a view state is one of `match`'s own states (an error is never tagged like one). */
const is =
  <Tag extends Own>(tag: Tag) =>
  <Row, E>(state: ViewState<Row, E>): state is Of<Row, E, Tag> =>
    Predicate.isTagged(state, tag);

/**
 * A value shaped like a stock `useLiveQuery` result over a source, in a given state. `match`
 * accepts it as it accepts the real one (no casts) and reads the same state from it, with the
 * source's errors. For view tests: render a composition component's `match` branches without a
 * server. `retry` is recorded in `retried`.
 */
export type ViewResult<Row> = {
  readonly data: Array<Row>;
  readonly status: CollectionStatus;
  readonly isEnabled: true;
  readonly isReady: boolean;
  readonly isLoadingError: boolean;
  readonly isCrashed: false;
  readonly health: HealthNode;
  readonly collection: { readonly reload: () => Promise<void> };
  /** How many times a handler's `retry` reloaded it. */
  readonly retried: () => number;
};

const problem = (cause: TaggedFailure, attempts: number): HealthProblem => {
  const info = { name: cause._tag, message: cause._tag, at: 0, cause };

  return { ...info, errors: Array.from({ length: attempts }, () => info) };
};

const nodeOf = (
  id: string,
  status: CollectionStatus,
  failureReason: HealthProblem | null,
  error: HealthProblem | null,
): HealthNode => ({
  alias: "root",
  collectionId: id,
  kind: "source",
  status,
  hasErrors: failureReason !== null || error !== null,
  failureReason,
  error,
  reloading: false,
  sources: [],
});

/** `view(customers.list(input), state)`: a live query result over that source in `state`. */
export const view = <Row extends object>(
  source: Source<Row>,
  // `NoInfer`: the row type (and so its errors) comes from the source, never from a state's
  // `data`, whose plain rows carry no error marker.
  state: ViewState<NoInfer<Row>, Extract<ErrorsOf<Array<NoInfer<Row>>>, TaggedFailure>>,
): ViewResult<Row> => {
  let retried = 0;

  const collection = {
    reload: async () => {
      retried += 1;
    },
  };

  const id = source.id ?? "view";

  const base = {
    isEnabled: true as const,
    isCrashed: false as const,
    collection,
    retried: () => retried,
  };

  if (is("Loading")(state))
    return {
      ...base,
      data: [],
      status: "loading",
      isReady: false,
      isLoadingError: false,
      health: nodeOf(id, "loading", null, null),
    };

  if (is("Retrying")(state))
    return {
      ...base,
      data: [...state.data],
      status: "ready",
      isReady: true,
      isLoadingError: false,
      health: nodeOf(id, "ready", problem(state.error, state.attempt - 1), null),
    };

  if (is("Ready")(state)) {
    const feed = Option.map(state.feed, (error) => problem(error, 1));

    return {
      ...base,
      data: [...state.data],
      status: "ready",
      isReady: true,
      isLoadingError: false,
      health: nodeOf(id, "ready", null, Option.getOrNull(feed)),
    };
  }

  // SAFETY: none of the state tags: one of the source's typed errors.
  const error = state as TaggedFailure;

  return {
    ...base,
    data: [],
    status: "error",
    isReady: false,
    isLoadingError: true,
    health: nodeOf(id, "error", null, problem(error, 1)),
  };
};
