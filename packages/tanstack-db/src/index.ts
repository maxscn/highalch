/**
 * HighAlch: an alchemy Domain synced into TanStack DB collections, with typed errors from the
 * Domain definitions. React-free; the provider is in `@highalch/tanstack-db/react`, the server-only
 * declarations in `@highalch/tanstack-db/server` (re-exported here).
 *
 * ```ts
 * import * as HighAlch from "@highalch/tanstack-db";
 * ```
 */
import type * as Domain from "@alchemy.run/domain";

export { Feed, Rows, Projection, upserted, removed } from "./server";

export type {
  AnyFeed,
  Change,
  FeedDefinition,
  FeedError,
  ProjectionOptions,
  RowOf,
  RowsDefinition,
  ScopeSchema,
} from "./server";

export {
  collection,
  read,
  query,
  command,
  inserts,
  updates,
  deletes,
  edits,
  sends,
  Inserts,
  Keyed,
  Edits,
  Sends,
} from "./declare";

export type {
  Addressing,
  Args,
  Collection,
  CommandOptions,
  InsertOptions,
  UpdateOptions,
  KeyFn,
  TargetFn,
  CommandSpec,
  Draft,
  QuerySpec,
  EntryOf,
  Page,
  QueryInput,
  ResultRow,
  Source,
  SubsetError,
  SubsetRow,
  Subsets,
} from "./declare";

export { created, createdKey } from "./command";

export type {
  Call,
  Callbacks,
  Command,
  Created,
  ErrorOf,
  InputOf,
  Paced,
  ReplyOf,
  Settled,
  TargetOf,
} from "./command";

export { make, layer, Client, close, activate, current, reload, transient } from "./client";

export type { Config, Retry, Settings } from "./client";

export { anyOf, match } from "./match";

export { Suspend } from "./live";

export type { AnyOf, Matchable, Matcher, StateOf } from "./match";

export { Defect } from "./state";

export type { TaggedFailure } from "./state";

export type { Controls, ErrorsOf, Floor, Live, LiveState, Marked, Register } from "./live";

type ServedQueries<A extends Domain.Api.Any> = Extract<A["serves"][number], Domain.Query.Any>;

type ServedViews<A extends Domain.Api.Any> = Extract<A["serves"][number], Domain.View.Any>;

type ServedStreams<A extends Domain.Api.Any> = Extract<A["serves"][number], Domain.Stream.Any>;

/**
 * Every error a read of an Api can fail with: each served query's, view's and stream's. Use it
 * as the `Register` floor for live queries whose projections drop the row marker.
 */
export type ApiErrors<A extends Domain.Api.Any> =
  | (ServedQueries<A> extends infer Q extends Domain.Query.Any ? Domain.Api.QueryError<Q> : never)
  | (ServedViews<A> extends infer V extends Domain.View.Any
      ? Domain.Api.ReadError<V["definition"]>
      : never)
  | (ServedStreams<A> extends infer S extends Domain.Stream.Any
      ? Domain.Api.ReadError<S["definition"]>
      : never);
