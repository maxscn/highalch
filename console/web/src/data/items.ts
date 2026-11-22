import { resultPartLinks } from "@highalch/console-domain/Console.collections";
import type { ResultRow } from "@highalch/console-domain/Run/Result.rows";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import * as Results from "@highalch/console-client/Results";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * A run's result items (tests, fuzz cases, traces, its snapshot map) live in storage, not in
 * rows: the run's `ResultRows` index them, `resultPartLinks` signs a short-lived GET link per
 * stored object, and the browser fetches and decodes the JSON. A part's content never changes
 * (its key holds its digest), so each part is fetched once per page and kept by key.
 *
 * Reading is Suspense-based: `itemsOf(...)` returns one promise per set of keys that resolves to
 * a tagged value (`Items` or a tagged error) and never rejects; a component `use`s it and renders
 * it with `HighAlch.match`.
 */

/** The decoded items of a run's parts. */
export class Items<A> extends Data.TaggedClass("Items")<{ readonly items: ReadonlyArray<A> }> {}

/** A part could not be downloaded (its link expired, storage refused, offline). */
export class ItemsUnavailable extends Data.TaggedError("ItemsUnavailable")<{
  readonly key: string;
  readonly status: number;
}> {}

/** A part's JSON does not decode as the items this page reads. */
export class ItemsUndecodable extends Data.TaggedError("ItemsUndecodable")<{
  readonly key: string;
  readonly message: string;
}> {}

export type Loaded<A> = Items<A> | ItemsUnavailable | ItemsUndecodable;

type Link = { readonly key: string; readonly link: { readonly url: string } | null };

/** A part's link and how many of its items the run was charged for: only those are shown. */
export type Part = Link & { readonly charged: number };

const fetchPart = <A, I>(schema: Schema.Codec<A, I>, part: Part) =>
  Effect.map(fetchJson(Schema.Array(schema), part, [] as ReadonlyArray<A>), (items) =>
    items.slice(0, part.charged),
  );

const fetchJson = <A, I>(schema: Schema.Codec<A, I>, link: Link, empty: A) =>
  Effect.gen(function* () {
    if (link.link === null) return empty;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(link.link.url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        (error) =>
          new ItemsUnavailable({
            key: link.key,
            status:
              error._tag === "HttpClientError" && "response" in error.reason
                ? (error.reason.response?.status ?? 0)
                : 0,
          }),
      ),
    );
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError((error) =>
        error._tag === "SchemaError"
          ? new ItemsUndecodable({ key: link.key, message: error.message })
          : new ItemsUnavailable({ key: link.key, status: response.status }),
      ),
    );
  });

const cache = new Map<string, Promise<Loaded<unknown>>>();

/** The items of these parts, decoded with `schema`, in part order; one promise per key set. */
export const itemsOf = <A, I>(
  kind: string,
  schema: Schema.Codec<A, I>,
  links: ReadonlyArray<Part>,
): Promise<Loaded<A>> => {
  const id = `${kind}:${links.map((link) => link.key).join(",")}`;
  const known = cache.get(id);
  if (known) return known as Promise<Loaded<A>>;
  const loaded = Effect.runPromise(
    Effect.forEach(links, (link) => fetchPart(schema, link), { concurrency: 4 }).pipe(
      Effect.map((parts): Loaded<A> => new Items({ items: parts.flat() })),
      Effect.catch((error) => Effect.succeed<Loaded<A>>(error)),
      Effect.provide(FetchHttpClient.layer),
    ),
  );
  cache.set(id, loaded as Promise<Loaded<unknown>>);
  return loaded;
};

/** Every download started so far, settled: what a story waits for before it captures a frame. */
export const downloads = () =>
  Promise.all([...cache.values(), ...snapshotCache.values(), ...documentCache.values()]).then(
    () => undefined,
  );

/** The item schemas, as the reporters upload them. */
export const TestItem = Results.TestItem;
export type TestItem = Results.TestItem;
export const CaseItem = Results.CaseItem;
export const TraceItem = Results.TraceItem;

/** One stored snapshot comparison: by item key (`p|<project>|<test id>[|<attachment>]`). */
export const SnapshotEntry = Schema.Struct({
  status: Schema.Literals(["unchanged", "changed", "new", "removed", "schema-changed"]),
  baselineRunId: Schema.optional(Schema.String),
  baselineArtifactId: Schema.optional(Schema.String),
});
export type SnapshotEntry = typeof SnapshotEntry.Type;

/** The parts of a run's index that hold its current items of `part` (not the baseline's removed). */
export const partsOf = (rows: ReadonlyArray<ResultRow>, part: ResultRow["part"]) =>
  rows.filter((row) => row.part === part && !row.key.includes("/removed."));

/** The `resultPartLinks` source of these parts (at most 50 keys a call). */
export const linksOf = (run: string, keys: ReadonlyArray<string>) =>
  resultPartLinks({ run: RunId.make(run), keys: keys.slice(0, 50) });

/** A run's snapshot map (one object, written when the run was compared), by item key. */
export class Snapshots extends Data.TaggedClass("Snapshots")<{
  readonly entries: ReadonlyMap<string, SnapshotEntry>;
}> {}

const snapshotCache = new Map<string, Promise<Snapshots | ItemsUnavailable | ItemsUndecodable>>();

export const snapshotsOf = (
  link: Link,
): Promise<Snapshots | ItemsUnavailable | ItemsUndecodable> => {
  const known = snapshotCache.get(link.key);
  if (known) return known;
  const loaded = Effect.runPromise(
    fetchJson(Schema.Record(Schema.String, SnapshotEntry), link, {}).pipe(
      Effect.map((record) => new Snapshots({ entries: new Map(Object.entries(record)) })),
      Effect.catch((error) => Effect.succeed(error)),
      Effect.provide(FetchHttpClient.layer),
    ),
  );
  snapshotCache.set(link.key, loaded);
  return loaded;
};

/** One decoded JSON document of storage (a story report, say), or why it could not be read. */
export class Document<A> extends Data.TaggedClass("Document")<{ readonly value: A }> {}

const documentCache = new Map<string, Promise<unknown>>();

export const documentOf = <A, I>(
  schema: Schema.Codec<A, I>,
  link: Link,
): Promise<Document<A | null> | ItemsUnavailable | ItemsUndecodable> => {
  const known = documentCache.get(link.key);
  if (known) return known as Promise<Document<A | null> | ItemsUnavailable | ItemsUndecodable>;
  const loaded = Effect.runPromise(
    fetchJson(Schema.NullOr(schema), link, null).pipe(
      Effect.map((value) => new Document({ value })),
      Effect.catch((error) => Effect.succeed(error)),
      Effect.provide(FetchHttpClient.layer),
    ),
  );
  documentCache.set(link.key, loaded);
  return loaded;
};

export const testKey = (test: { readonly project: string; readonly id: string }) =>
  `p|${test.project}|${test.id}`;

/**
 * The elements of a `HighAlch.query` answer that is an array. The query writes the whole answer as
 * its one row, which a live query hands back as an object with the elements under index keys
 * (plus TanStack DB's virtual `$` fields), though it is typed as the array. Reported to HighAlch.
 */
export const elementsOf = <A>(answer: ReadonlyArray<A>): ReadonlyArray<A> =>
  Array.isArray(answer)
    ? answer
    : Object.entries(answer)
        .filter(([key]) => /^\d+$/.test(key))
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, value]) => value as A);
