/**
 * Unstable internals of `@highalch/tanstack-db` for `@highalch/story` (and other test kits). Nothing here
 * is covered by semver: names and shapes change without notice. Applications use `@highalch/tanstack-db`.
 *
 * - `waitKind`: the current HighAlch wait, for a story’s Clock to inspect.
 * - `connectionOf` / `Connection`: a client's Domain connection, its feed subscriptions (each with
 *   a read-only `current`: caught up and not failed) and its materialised subsets.
 * - `Live` / `fromLive`: the constructors of `match`'s live states and the conversion `match` uses.
 * - `Settled`: the constructors of a command's settled value.
 * - `keyOf`, `Row`, `Input`, `Answer`: how rows, inputs and answers are seen by the core.
 */
export { connectionOf, waitKind, type Connection, type Wait } from "./client";

export { Settled, type SettledDefinition } from "./command";

export type { Subscription } from "./feed";

export { fromLive, Live, type LiveDefinition, type LiveResult } from "./live";

export type * as Rows from "./rows";

export { keyOf, type Answer, type Input, type Row } from "./values";
