/**
 * The server side of the Domain-backed layer: a feed (one `Domain.Stream` per scope), the
 * entities on it and the one projection that writes it. It imports only `@alchemy.run/domain`
 * and `effect`, so a Domain model (and the Worker hosting it) can declare row feeds without
 * bundling TanStack DB, and Node can load it from source (its relative import names the `.ts`
 * file). `@lowalch/tanstack-db` re-exports it.
 *
 * ```ts
 * import * as LowAlch from "@lowalch/tanstack-db/server";
 * ```
 */
export { Feed, Rows, Projection, upserted, removed } from "./rows.ts";

export type {
  AnyFeed,
  Change,
  FeedDefinition,
  FeedError,
  ProjectionOptions,
  RowOf,
  RowsDefinition,
  ScopeSchema,
  Writer,
  WriterInput,
  WriterPayload,
} from "./rows.ts";
