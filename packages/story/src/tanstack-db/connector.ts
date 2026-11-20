import { DbClient, type CollectionStatus, type HealthNode, type Transaction } from "@tanstack/db";
import { Context, Option, Predicate } from "effect";
import type { ReactElement } from "react";
import type { Invariant } from "../invariants";
import type { Tagged } from "../values";
import type { World } from "../world";

/** One change of a collection, as a story reads it (with TanStack DB's virtual fields). */
export type Change = {
  readonly type: string;
  readonly key: string | number;
  readonly value: object & { readonly $hasPendingWrites?: boolean };
};

/** What a story reads of a collection: its id, state, rows and changes; `reload` if it has one. */
export type Watched = {
  readonly id: string;
  readonly status: CollectionStatus;
  readonly health: HealthNode;
  readonly values: () => Iterable<object>;
  readonly reload?: () => Promise<void>;
  readonly subscribeChanges: (
    callback: (changes: ReadonlyArray<Change>) => void,
    options: { readonly includeInitialState: boolean },
  ) => { readonly unsubscribe: () => void };
};

/**
 * How the story's TanStack DB clients are made and read, for one story run. The default is plain
 * TanStack DB (a `DbClient` per scope, collections from the sources as they are); a connector
 * that syncs a Domain (`@highalch/story/lowalch`) makes clients that reach it through the world's
 * wires, and says what its feeds wait for, how its read states and keys read, and what it keeps.
 */
export type Connector = {
  /** The client of a scope. */
  readonly connect: (scope: string) => Promise<DbClient>;
  /** Closes a client when the story ends (its commands in flight let through first). */
  readonly close: (db: DbClient, scope: string) => Promise<void>;
  /** Why a client is not quiet now (a live feed behind the server), or `None`. */
  readonly busy: (db: DbClient, scope: string) => Promise<Option.Option<string>>;
  /**
   * A collection's read state, as the app's views read a live query over it: `Loading`, `Ready`,
   * `Missing` (with `single`), or another tagged state or error.
   */
  readonly state: (collection: Watched, single: boolean) => Tagged;
  /** The key of the row a command's transaction addresses (empty for none). */
  readonly keyOf: (transaction: Transaction) => string;
  /** Registers a client for code that runs without one; the release. */
  readonly activate: (db: DbClient) => () => void;
  /**
   * An element under the provider a mounted component reads its client from (a screen uses
   * TanStack DB's `DbProvider` when a connector has none).
   */
  readonly provide?: (db: DbClient, element: ReactElement) => ReactElement;
  /** Invariants `Db.invariants` adds for these clients (a feed's: rows never flicker back). */
  readonly invariants: ReadonlyArray<Invariant>;
};

/**
 * The connector of a story's clients, as a service: a function of the run's world. A host's
 * `adapters` (or a Layer of your own) provide it; without one, clients are plain TanStack DB.
 */
export class Connect extends Context.Service<Connect, (world: World) => Connector>()(
  "@highalch/story/tanstack-db/Connect",
) {}

/** The plain TanStack DB read state of a collection. */
const stateOf = (collection: Watched, single: boolean): Tagged => {
  if (collection.status === "error") {
    const cause = collection.health.error?.cause ?? collection.health.failureReason?.cause;

    if (Predicate.hasProperty(cause, "_tag") && Predicate.isString(cause._tag))
      // SAFETY: a tagged error is a tagged value.
      return cause as Tagged;

    return { _tag: "Failed" };
  }

  if (collection.status !== "ready") return { _tag: "Loading" };

  if (single && [...collection.values()].length === 0) return { _tag: "Missing" };

  return { _tag: "Ready" };
};

/** Plain TanStack DB: a `DbClient` per scope; collections are what the sources make them. */
export const plain = (): Connector => ({
  connect: async () => new DbClient(),
  close: async () => {},
  busy: async () => Option.none(),
  state: stateOf,
  keyOf: (transaction) =>
    Option.match(Option.fromUndefinedOr(transaction.mutations[0]), {
      onNone: () => "",
      onSome: (mutation) => String(mutation.key),
    }),
  activate: () => () => {},
  invariants: [],
});
