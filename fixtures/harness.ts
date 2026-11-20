import type { Collection, CollectionOptions, DbClient, NonSingleResult } from "@tanstack/db";
import { Effect, Layer, Predicate, Schedule } from "effect";
import * as LowAlch from "@lowalch/tanstack-db";
import { address, host, NotesApi, type Note } from "./notebook";

export type Host = Awaited<ReturnType<typeof host>>;

/** Retries a transport failure once after 20 ms; anything else fails at once. */
export const retryTransport = (delay: number, times: number): LowAlch.Retry =>
  Schedule.spaced(delay).pipe(
    Schedule.upTo({ times }),
    Schedule.while(({ input }: { input: LowAlch.TaggedFailure | LowAlch.Defect }) =>
      Predicate.isTagged(input, "RpcClientError"),
    ),
  );

export const quick = retryTransport(20, 1);

/** Opens one account's client on the host; `close` is registered with `cleanup`. */
export const account = (
  server: Host,
  scope: string,
  cleanup: Array<() => Promise<void>>,
  options: Partial<LowAlch.Config<typeof NotesApi>> = {},
) => {
  const db = LowAlch.make({
    api: NotesApi,
    layer: Layer.succeed(NotesApi.Client, server.wire.client),
    scope,
    reloadDelay: 10,
    settleTimeout: 2_000,
    retry: quick,
    ...options,
  });

  cleanup.push(() => Effect.runPromise(LowAlch.close(db)));

  return db;
};

/** Waits until `check` holds, polling every 5 ms for up to two seconds. */
export const until = async (check: () => boolean, label = "condition") => {
  for (let tries = 0; tries < 400 && !check(); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));

  if (!check()) throw new Error(`Timed out waiting for ${label}`);
};

/** Lets pending timers and promises run. */
export const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Materialises a descriptor in a client and keeps it observed, as a mounted live query would. */
export const observe = <T extends object>(
  db: DbClient,
  source: CollectionOptions<T, string> & NonSingleResult,
  cleanup: Array<() => Promise<void>>,
) => {
  const collection = db.collection(source);
  const subscription = collection.subscribeChanges(() => {}, { includeInitialState: true });

  cleanup.push(async () => subscription.unsubscribe());

  return collection;
};

/** The titles of a collection's notes, by key order. */
export const titles = (collection: Collection<Note, string>) =>
  [...collection.values()]
    .sort((a, b) => a.NoteId.localeCompare(b.NoteId))
    .map((note) => `${note.NoteId}:${note.title}`);

/** Creates notes directly on the server (as another client would) and waits for the index. */
export const seed = async (server: Host, ...notes: ReadonlyArray<Omit<Note, "pinned">>) => {
  for (const note of notes)
    await server.send((client) =>
      client.CreateNote(address(note.account, note.NoteId), {
        account: note.account,
        BookId: note.BookId,
        title: note.title,
      }),
    );

  await server.indexed((stored) => notes.every((note) => stored.has(note.NoteId)));
};
