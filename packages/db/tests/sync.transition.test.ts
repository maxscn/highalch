import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Domain from "@alchemy.run/domain";
import {
  createLiveQueryCollection,
  createOptimisticAction,
  createPacedMutations,
  debounceStrategy,
  DbClient,
} from "@tanstack/db";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import * as HighAlch from "@highalch/db";
import { connectionOf, waitKind } from "@highalch/db/internal";
import {
  account,
  observe,
  retryTransport,
  seed,
  tick,
  titles,
  until,
  type Host,
} from "../../../fixtures/harness";
import {
  address,
  host,
  BookRows,
  NotebookChanges,
  NotebookWriter,
  NoteLocked,
  NoteRows,
  NotesApi,
  Notes,
  NotesByCursor,
  NotesByTitle,
  WrappedNotes,
  RenameNote,
  TouchNote,
  transport,
  type Book,
  type Note,
} from "../../../fixtures/notebook";
import { books, notes, stats, touch } from "../../../fixtures/notes";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const open = async (): Promise<Host> => {
  const server = await host();

  cleanup.push(() => server.dispose());

  return server;
};

const ada = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada" };

const bob = { NoteId: "n2", account: "acc-1", BookId: "b2", title: "Bob" };

const cyd = { NoteId: "n3", account: "acc-1", BookId: "b1", title: "Cyd" };

const eve = { NoteId: "e1", account: "acc-2", BookId: "b1", title: "Eve" };

/** Every value of one key a collection showed, in order (`-` when it left). */
const history = (
  collection: ReturnType<typeof observe<Note>>,
  key: string,
  read: (note: Note) => string,
) => {
  const seen: Array<string> = [];

  collection.subscribeChanges((changes) => {
    for (const change of changes)
      if (change.key === key) seen.push(change.type === "delete" ? "-" : read(change.value));
  });

  return seen;
};

/** The three subsets every subset test reads: a page, one note and one book. */
const subsets = (db: DbClient) => ({
  list: observe<Note>(db, notes.list({ account: "acc-1" }), cleanup),
  one: observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup),
  book: observe<Note>(db, notes.byBook({ BookId: "b1" }), cleanup),
});

const ready = (...collections: ReadonlyArray<{ isReady: () => boolean }>) =>
  until(() => collections.every((collection) => collection.isReady()), "ready");

it("f(scoped HighAlch client, a command and scope exit) → command uses the service and the feed stops", async () => {
  const server = await open();
  await seed(server, ada);
  const config = {
    api: NotesApi,
    layer: Layer.succeed(NotesApi.Client, server.wire.client),
    scope: ada.account,
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* HighAlch.Client;
      const list = observe(db, notes.list({ account: ada.account }), cleanup);

      yield* Effect.promise(() => ready(list));
      expect(server.wire.counts.open).toBe(1);
      expect(titles(list)).toEqual(["n1:Ada"]);
      yield* notes.rename.effect({ NoteId: ada.NoteId, title: "Abel" });
      expect(titles(list)).toEqual(["n1:Abel"]);
    }).pipe(Effect.provide(HighAlch.layer(config))),
  );

  await until(() => server.wire.counts.open === 0, "scope closed the feed");
});

describe("f(subsets, load)", () => {
  it("f(nothing loaded, first load) → ready with each query's rows, one feed for all", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);
    const { list, one, book } = subsets(db);

    await ready(list, one, book);

    expect(titles(list)).toEqual(["n1:Ada", "n2:Bob"]);
    expect(titles(one)).toEqual(["n1:Ada"]);
    expect(titles(book)).toEqual(["n1:Ada"]);
    expect(server.wire.counts.open).toBe(1);
  });

  it("f(load in flight, writes race the query) → every write applied once, nothing missed", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const api = server.wire.client;
    const gate = Promise.withResolvers<void>();
    const delayed = Promise.withResolvers<void>();
    const db = account(server, ada.account, cleanup, {
      layer: Layer.succeed(NotesApi.Client, {
        ...api,
        NotebookChanges: {
          ...api.NotebookChanges,
          events: (...args) =>
            api.NotebookChanges.events(...args).pipe(
              Stream.tap((frame) =>
                Domain.Read.isEvent(frame) && frame.envelope.seq > 3
                  ? Effect.promise(() => {
                      delayed.resolve();
                      return gate.promise;
                    })
                  : Effect.void,
              ),
            ),
        },
      }),
    });
    const witness = observe(db, notes.byBook({ BookId: ada.BookId }), cleanup);
    const removed = observe(db, notes.get({ NoteId: bob.NoteId }), cleanup);
    await ready(witness, removed);
    const release = server.hold();
    const list = observe<Note>(db, notes.list({ account: "acc-1" }), cleanup);

    try {
      // The query answered from the store as it was; these writes land after the snapshot cursor.
      await until(() => server.store.asked.includes("Notes"), "query asked");
      await server.send((client) =>
        client.RenameNote(address("acc-1", "n1"), { NoteId: "n1", title: "Ada 2" }),
      );
      await server.send((client) => client.DeleteNote(address("acc-1", "n2"), { NoteId: "n2" }));
      await server.send((client) =>
        client.CreateNote(address("acc-1", "n3"), { account: "acc-1", BookId: "b1", title: "Cyd" }),
      );
      await delayed.promise;
      await until(() => witness.get(ada.NoteId)?.title === "Ada 2", "rename delivered");

      expect(list.isReady()).toBe(false);

      // The command receipts do not fence the feed. Wait for the last two writes to arrive.
      gate.resolve();
      await until(
        () => witness.has(cyd.NoteId) && !removed.has(bob.NoteId),
        "all writes delivered",
      );
      expect(list.isReady()).toBe(false);

      release();
      await ready(list);

      expect(titles(list)).toEqual(["n1:Ada 2", "n3:Cyd"]);
      expect(countAsked(server).Notes).toBe(1);
    } finally {
      gate.resolve();
      release();
    }
    expect(list.size).toBe(2);
  });
  it("f(ready rule-based subset, one feed batch) → one ordered snapshot of all changes", async () => {
    const server = await open();
    await seed(server, ada, bob);
    const api = server.wire.client;
    const started = Promise.withResolvers<number>();
    const batch = Promise.withResolvers<Awaited<ReturnType<Host["entries"]>>>();
    const db = account(server, ada.account, cleanup, {
      layer: Layer.succeed(NotesApi.Client, {
        ...api,
        NotebookChanges: {
          ...api.NotebookChanges,
          events: (_scope, options) => {
            const after = options?.after ?? 0;

            started.resolve(after);
            return Stream.make(Domain.Read.CaughtUp.make({ cursor: after })).pipe(
              Stream.concat(Stream.fromArrayEffect(Effect.promise(() => batch.promise))),
              Stream.concat(Stream.never),
            );
          },
        },
      }),
    });
    const list = observe(db, notes.list({ account: ada.account }), cleanup);
    await ready(list);
    const after = await started.promise;
    const shown: Array<Array<string>> = [];
    const published = Promise.withResolvers<void>();
    const subscription = list.subscribeChanges(() => {
      shown.push(titles(list));
      if (list.has(cyd.NoteId)) published.resolve();
    });
    cleanup.push(async () => subscription.unsubscribe());

    await server.send((client) =>
      client.RenameNote(address(ada.account, ada.NoteId), { NoteId: ada.NoteId, title: "Ada 2" }),
    );
    await server.send((client) =>
      client.DeleteNote(address(ada.account, bob.NoteId), { NoteId: bob.NoteId }),
    );
    const receipt = await server.send((client) =>
      client.CreateNote(address(ada.account, cyd.NoteId), {
        account: ada.account,
        BookId: cyd.BookId,
        title: cyd.title,
      }),
    );
    await server.send((client) =>
      client.NotebookChanges.peek(ada.account, {
        atLeast: { stream: receipt.stream, version: receipt.version },
      }),
    );
    batch.resolve(await server.entries(ada.account, after));
    await published.promise;

    expect(shown).toEqual([["n1:Ada 2", "n3:Cyd"]]);
    expect(countAsked(server).Notes).toBe(1);
  });
});

describe("f(ready subsets, feed change)", () => {
  it("f(three subsets, server rename then delete) → each subset that shows the row follows", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);
    const { list, one, book } = subsets(db);

    await ready(list, one, book);
    await server.send((client) =>
      client.RenameNote(address("acc-1", "n1"), { NoteId: "n1", title: "Ada 2" }),
    );
    await until(() => one.get("n1")?.title === "Ada 2", "rename");

    expect(titles(list)).toEqual(["n1:Ada 2", "n2:Bob"]);
    expect(titles(book)).toEqual(["n1:Ada 2"]);

    await server.send((client) => client.DeleteNote(address("acc-1", "n1"), { NoteId: "n1" }));
    await until(() => !list.has("n1"), "delete");

    expect(titles(list)).toEqual(["n2:Bob"]);
    expect(titles(one)).toEqual([]);
    expect(titles(book)).toEqual([]);
  });

  it("f(rule-based subsets, feed changes) → all follows the whole list; one and where follow their rules", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const clock = reloads();
    const db = account(server, "acc-1", cleanup, { clock: clock.clock });
    const { list, book } = subsets(db);
    const later = observe<Note>(db, notes.get({ NoteId: "n3" }), cleanup);

    await ready(list, book, later);

    const asked = countAsked(server);

    await server.send((client) =>
      client.CreateNote(address("acc-1", "n3"), { account: "acc-1", BookId: "b1", title: "Cyd" }),
    );
    await until(() => book.has("n3") && later.has("n3") && list.has("n3"), "n3 everywhere");

    // A rule that stops holding takes the row out of that subset only.
    await server.send((client) =>
      client.MoveNote(address("acc-1", "n1"), { NoteId: "n1", BookId: "b2" }),
    );
    await until(() => !book.has("n1"), "moved out of b1");

    expect(list.get("n1")?.BookId).toBe("b2");

    await server.send((client) => client.DeleteNote(address("acc-1", "n2"), { NoteId: "n2" }));
    await until(() => !list.has("n2"), "removed from the whole list");
    clock.advance();
    await tick();

    expect(titles(list)).toEqual(["n1:Ada", "n3:Cyd"]);
    expect(countAsked(server)).toEqual(asked);
  });

  it("f(rows and where, feed changes) → selected rows and rule membership without another query", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const wrapped = HighAlch.collection(NoteRows, {
      queries: {
        list: HighAlch.read(WrappedNotes)
          .rows((answer) => answer.Items)
          .where((row, input) => row.account === input.account),
      },
    });
    const clock = reloads();
    const db = account(server, "acc-1", cleanup, { clock: clock.clock });
    const list = observe<Note>(
      db,
      wrapped.list({ account: "acc-1", Offset: 0, Limit: 100 }),
      cleanup,
    );

    await ready(list);
    expect(titles(list)).toEqual(["n1:Ada", "n2:Bob"]);

    await seed(server, cyd);
    await until(() => list.has(cyd.NoteId), "rule placed the new row");
    clock.advance();
    await tick();

    expect(titles(list)).toEqual(["n1:Ada", "n2:Bob", "n3:Cyd"]);
    expect(countAsked(server).WrappedNotes).toBe(1);
  });

  it("f(two accounts, module-level declarations) → each client follows only its own scope", async () => {
    const server = await open();

    await seed(server, ada, eve);

    const first = account(server, "acc-1", cleanup);
    const second = account(server, "acc-2", cleanup);
    const mine = observe<Note>(first, notes.byBook({ BookId: "b1" }), cleanup);
    const theirs = observe<Note>(second, notes.byBook({ BookId: "b1" }), cleanup);

    await ready(mine, theirs);

    expect(first.collection(notes.byBook({ BookId: "b1" }))).not.toBe(
      second.collection(notes.byBook({ BookId: "b1" })),
    );

    // The query is not scoped: both clients start with both notes of book b1.
    expect(titles(mine)).toEqual(["e1:Eve", "n1:Ada"]);

    await notes.rename.with({ client: first })({ NoteId: "n1", title: "Mine" }).when("settled");
    await server.send((client) =>
      client.RenameNote(address("acc-2", "e1"), { NoteId: "e1", title: "Theirs" }),
    );
    await until(() => theirs.get("e1")?.title === "Theirs", "acc-2 feed");
    await tick(30);

    // Each feed carries only its account's changes.
    expect(mine.get("e1")?.title).toBe("Eve");
    expect(theirs.get("n1")?.title).toBe("Ada");
    expect(server.wire.counts.open).toBe(2);
  });
});

/** How many times each query was asked. */
const countAsked = (server: Host) => {
  const count = (name: string) => server.store.asked.filter((asked) => asked === name).length;

  return {
    Notes: count("Notes"),
    NoteById: count("NoteById"),
    NotesByBook: count("NotesByBook"),
    NotesByTitle: count("NotesByTitle"),
    NotesByCursor: count("NotesByCursor"),
    WrappedNotes: count("WrappedNotes"),
    NoteStats: count("NoteStats"),
  };
};

/** Controls the reload delay while letting command settlement and feed I/O run normally. */
const reloads = () => {
  const pending = new Set<() => void>();
  const live = Effect.runSync(Clock.Clock);
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
    currentTimeMillis: live.currentTimeMillis,
    currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
    currentTimeNanos: live.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.flatMap(waitKind, (wait) => {
        if (wait !== "reload") return live.sleep(duration);

        return Effect.callback<void>((resume) => {
          const run = () => resume(Effect.void);

          pending.add(run);

          return Effect.sync(() => {
            pending.delete(run);
          });
        });
      }),
  };

  return {
    clock,
    advance: () => {
      const elapsed = [...pending];

      pending.clear();
      for (const run of elapsed) run();
    },
  };
};

/** Only a matching feed cause can confirm the command: the receipt cursor is unavailable. */
const causeLayer = (server: Host, cause: string) => {
  const api = server.wire.client;

  return Layer.succeed(NotesApi.Client, {
    ...api,
    NotebookChanges: {
      ...api.NotebookChanges,
      peek: (key, options) => {
        if (options?.atLeast) return Effect.fail(transport());

        return api.NotebookChanges.peek(key, options);
      },
      events: (key, options) =>
        api.NotebookChanges.events(key, options).pipe(
          Stream.map((frame) => {
            if (Domain.Read.isCaughtUp(frame) || frame.envelope.commandId !== cause) return frame;

            return {
              ...frame,
              event: { ...frame.event, cause },
              envelope: { ...frame.envelope, commandId: "feed-writer" },
            };
          }),
        ),
    },
  });
};

describe("f(query declaration, configuration)", () => {
  it("rejects a second declaration with different membership in one call or across calls", () => {
    class Rows extends NoteRows {}
    const full = HighAlch.read(Notes).all();

    expect(() => HighAlch.collection(Rows, { queries: { bare: Notes, full } })).toThrow(
      "HighAlch.collection: conflicting declarations of query Notes for NoteRows",
    );
    const configured = HighAlch.collection(Rows, { queries: { full } });

    expect(() => HighAlch.collection(Rows, { queries: { bare: Notes } })).toThrow(
      "HighAlch.collection: conflicting declarations of query Notes for NoteRows",
    );
    const repeated = HighAlch.collection(Rows, { queries: { full: HighAlch.read(Notes).all() } });

    expect(repeated.full({ account: "acc-1" }).id).toBe(configured.full({ account: "acc-1" }).id);
  });

  it("rejects .all() over a cursor page at runtime", () => {
    // @ts-expect-error bypass the type guard to exercise the runtime guard
    expect(() => HighAlch.read(NotesByCursor).all()).toThrow(
      "HighAlch.all cannot declare paged query NotesByCursor",
    );
  });
});

it("f(two cursor pages, deletion) → both pages re-ask with their own cursor and size", async () => {
  const server = await open();
  const input = { account: "acc-1" };
  const dan = { ...ada, NoteId: "n4", title: "Dan" };

  await seed(server, ada, bob, cyd, dan);
  const clock = reloads();
  const db = account(server, input.account, cleanup, { clock: clock.clock });
  const first = observe(db, notes.cursor(input, { take: 1 }), cleanup);
  const next = observe(db, notes.cursor(input, { after: "1", take: 2 }), cleanup);

  await ready(first, next);
  expect(titles(first)).toEqual(["n1:Ada"]);
  expect(titles(next)).toEqual(["n2:Bob", "n3:Cyd"]);
  expect(countAsked(server).NotesByCursor).toBe(2);

  await server.send((client) =>
    client.DeleteNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId }),
  );
  await until(() => !first.has(ada.NoteId), "cursor page patched");
  await server.indexed((stored) => !stored.has(ada.NoteId));
  clock.advance();

  await until(() => first.has(bob.NoteId) && next.has(dan.NoteId), "both pages reloaded");
  expect(titles(first)).toEqual(["n2:Bob"]);
  expect(titles(next)).toEqual(["n3:Cyd", "n4:Dan"]);
  expect(countAsked(server).NotesByCursor).toBe(4);
});

const manualClock = async () => {
  const scope = Scope.makeUnsafe();

  cleanup.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));

  return Effect.runPromise(Scope.provide(TestClock.make(), scope));
};

describe("f(query-decided page, a lagging answer)", () => {
  const input = { account: "acc-1", Offset: 0, Limit: 2 };

  it("f(accepted cursor, earlier delete delivered late) → patches once and re-asks once", async () => {
    const server = await open();
    await seed(server, ada, bob);
    const clock = await manualClock();
    const api = server.wire.client;
    const gate = Promise.withResolvers<void>();
    let heldSeq = 0;
    let peekedSeq = 0;
    let lagging = false;
    let previous: Domain.Query.ResultOf<typeof NotesByTitle> | undefined;
    const db = account(server, input.account, cleanup, {
      clock,
      layer: Layer.succeed(NotesApi.Client, {
        ...api,
        NotebookChanges: {
          ...api.NotebookChanges,
          events: (key, options) =>
            api.NotebookChanges.events(key, options).pipe(
              Stream.mapEffect((frame) =>
                Effect.gen(function* () {
                  if (
                    !Domain.Read.isCaughtUp(frame) &&
                    frame.event._tag === "NotebookChanges.Removed"
                  ) {
                    heldSeq = frame.envelope.seq;
                    yield* Effect.promise(() => gate.promise);
                  }
                  return frame;
                }),
              ),
            ),
          peek: (key, options) =>
            api.NotebookChanges.peek(key, options).pipe(
              Effect.tap((frame) =>
                Effect.sync(() => {
                  peekedSeq = frame?.envelope.seq ?? 0;
                }),
              ),
            ),
        },
        NotesByTitle: (input, options) =>
          api.NotesByTitle(input, options).pipe(
            Effect.map((answer) => {
              if (lagging && previous) return previous;

              previous = answer;

              return answer;
            }),
          ),
      }),
    });
    const page = observe(db, notes.page(input), cleanup);
    const list = observe(db, notes.list({ account: input.account }), cleanup);
    await ready(page, list);
    const seen = history(page, ada.NoteId, (row) => row.title);

    lagging = true;
    await server.send((client) =>
      client.DeleteNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId }),
    );
    await until(() => heldSeq > 0, "delete held");
    // The later frame can advance peek while the live delivery is blocked on the delete.
    await seed(server, cyd);
    for (let tries = 0; tries < 200; tries += 1) {
      if ((await server.entries(input.account, heldSeq)).length > 0) break;
      await tick(5);
    }

    HighAlch.reload(db, NoteRows);
    await Effect.runPromise(clock.adjust(10));
    await until(() => countAsked(server).NotesByTitle === 2, "explicit reload sent");
    await tick();
    expect(peekedSeq).toBeGreaterThan(heldSeq);
    expect(titles(page)).toEqual(["n1:Ada", "n2:Bob"]);
    seen.length = 0;

    lagging = false;
    gate.resolve();
    await until(() => list.has(cyd.NoteId), "both late entries delivered");
    expect(titles(page)).toEqual(["n2:Bob"]);
    expect(seen).toEqual(["-"]);
    expect(countAsked(server).NotesByTitle).toBe(2);
    await Effect.runPromise(clock.adjust(10));
    await until(() => page.has(cyd.NoteId), "one re-ask placed Cyd");
    await Effect.runPromise(clock.adjust(1_000));
    expect(countAsked(server).NotesByTitle).toBe(3);
  });

  it("f(feed rename, direct write, explicit reload) → publishes the newer query value", async () => {
    const server = await open();
    await seed(server, ada, bob);
    const clock = await manualClock();
    const db = account(server, input.account, cleanup, { clock });
    const page = observe(db, notes.page(input), cleanup);
    await ready(page);

    await server.send((client) =>
      client.RenameNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId, title: "Abel" }),
    );
    await until(() => page.get(ada.NoteId)?.title === "Abel", "feed rename");
    await server.indexed((stored) => stored.get(ada.NoteId)?.title === "Abel");
    const stored = server.store.notes.get(ada.NoteId);
    if (!stored) throw new Error("The renamed note was not stored");
    server.store.notes.set(ada.NoteId, { ...stored, title: "Imported" });

    HighAlch.reload(db, NoteRows);
    await Effect.runPromise(clock.adjust(10));
    await until(() => countAsked(server).NotesByTitle === 2, "explicit reload sent");
    await tick();
    expect(titles(page)).toEqual(["n1:Imported", "n2:Bob"]);
    await Effect.runPromise(clock.adjust(1_000));
    expect(countAsked(server).NotesByTitle).toBe(2);
  });

  it("f(page, three answers overtaken by changes) → refreshes without losing a confirmed insert", async () => {
    const server = await open();
    await seed(server, ada, bob);
    const clock = await manualClock();
    const cause = "third-answer-insert";
    const db = account(server, input.account, cleanup, { clock, layer: causeLayer(server, cause) });
    const page = observe(db, notes.page(input), cleanup);
    await ready(page);
    const aaron = { ...ada, NoteId: "n4", title: "Aaron" };
    await seed(server, aaron);
    HighAlch.reload(db, NoteRows);

    for (const [index, title] of ["Ada 1", "Ada 2"].entries()) {
      const release = server.hold();
      await Effect.runPromise(clock.adjust(10));
      await until(() => countAsked(server).NotesByTitle === index + 2, "earlier answer held");
      await server.send((client) =>
        client.RenameNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId, title }),
      );
      await until(() => page.get(ada.NoteId)?.title === title, "later rename delivered");
      await server.indexed((stored) => stored.get(ada.NoteId)?.title === title);
      release();
      await tick();
      expect(page.has(aaron.NoteId)).toBe(false);
    }

    const release = server.hold();
    await Effect.runPromise(clock.adjust(10));
    await until(() => countAsked(server).NotesByTitle === 4, "third answer held");
    const committed = Promise.withResolvers<HighAlch.Settled<unknown>>();
    const inserted = notes.create.with({ client: db })(
      { account: input.account, BookId: "b1", title: "Aardvark" },
      { id: cause, onCommitted: committed.resolve },
    );
    const key = HighAlch.created(inserted);
    await inserted.when("settled");
    expect(await committed.promise).toMatchObject({ _tag: "Committed" });
    expect(page.get(key)?.title).toBe("Aardvark");
    await server.indexed((stored) => stored.has(key));
    const seen: Array<string | undefined> = [];
    const subscription = page.subscribeChanges(() => seen.push(page.get(key)?.title));
    cleanup.push(async () => subscription.unsubscribe());

    release();
    await until(() => page.has(aaron.NoteId), "third answer refreshed page");
    expect(page.get(key)?.title).toBe("Aardvark");
    expect(countAsked(server).NotesByTitle).toBe(4);
    await Effect.runPromise(clock.adjust(10));
    await until(() => countAsked(server).NotesByTitle === 5, "follow-up re-asked");
    await tick();
    expect(page.get(key)?.title).toBe("Aardvark");
    expect(seen).not.toContain(undefined);
  });

  it.each([
    { action: "delete", count: 1 },
    { action: "upsert", count: 1 },
    { action: "upsert", count: 8 },
  ])(
    "f(ready, $count $action entries contradicted by a lagging read model) → four queries at most",
    async ({ action, count }) => {
      const server = await open();
      await seed(server, ada, bob, cyd);
      const clock = await manualClock();
      const api = server.wire.client;
      let previous: Domain.Query.ResultOf<typeof NotesByTitle> | undefined;
      let lagging = false;

      const db = account(server, input.account, cleanup, {
        clock,
        layer: Layer.succeed(NotesApi.Client, {
          ...api,
          NotesByTitle: (query, options) =>
            api.NotesByTitle(query, options).pipe(
              Effect.map((answer) => {
                if (lagging && previous) return previous;

                previous = answer;

                return answer;
              }),
            ),
        }),
      });
      const page = observe(db, notes.page(input), cleanup);

      await ready(page);
      expect(titles(page)).toEqual(["n1:Ada", "n2:Bob"]);
      lagging = true;

      if (action === "delete")
        await server.send((client) =>
          client.DeleteNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId }),
        );
      else {
        for (let index = 1; index <= count; index += 1)
          await server.send((client) =>
            client.RenameNote(address(input.account, ada.NoteId), {
              NoteId: ada.NoteId,
              title: `Abel ${index}`,
            }),
          );
      }

      const expected = ["n2:Bob"];

      if (action === "upsert") expected.unshift(`n1:Abel ${count}`);

      await until(() => titles(page).join() === expected.join(), "all entries patched in place");
      expect(titles(page)).toEqual(expected);
      const asked = countAsked(server).NotesByTitle;
      expect(asked).toBe(1);

      for (const [index, delay] of [10, 20, 40].entries()) {
        await Effect.runPromise(clock.adjust(delay));
        await until(() => countAsked(server).NotesByTitle === asked + index + 1, "lagging re-ask");
        await tick();
        expect(titles(page)).toEqual(expected);
        expect(page.isReady()).toBe(true);
      }

      await Effect.runPromise(clock.adjust(80));
      await until(() => countAsked(server).NotesByTitle === asked + 4, "third correction sent");
      await until(() => page.get(ada.NoteId)?.title === ada.title, "query wins at the cap");
      expect(titles(page)).toEqual(["n1:Ada", "n2:Bob"]);
      expect(page.isReady()).toBe(true);

      await Effect.runPromise(clock.adjust(10_000));
      // One debounced re-ask plus at most three corrections, regardless of burst size.
      expect(countAsked(server).NotesByTitle).toBe(asked + 4);

      lagging = false;
      HighAlch.reload(db, NoteRows);
      await Effect.runPromise(clock.adjust(10));
      await until(() => countAsked(server).NotesByTitle === asked + 5, "fresh re-ask");
      if (action === "delete") await until(() => page.has(cyd.NoteId), "fresh answer backfills");
      else expect(titles(page)).toEqual(expected);
    },
  );

  it("f(page, a held answer followed by a removal) → keeps the unaffected row visible", async () => {
    const server = await open();
    await seed(server, ada, bob);
    const clock = await manualClock();
    const db = account(server, input.account, cleanup, { clock });
    const page = observe(db, notes.page(input), cleanup);
    const list = observe(db, notes.list({ account: input.account }), cleanup);
    await ready(page, list);
    const shown = history(page, bob.NoteId, (row) => row.title);
    const aaron = { ...ada, NoteId: "n4", title: "Aaron" };

    await seed(server, aaron);
    await until(() => list.has(aaron.NoteId), "insert delivered");
    const release = server.hold();
    await Effect.runPromise(clock.adjust(10));
    await until(() => countAsked(server).NotesByTitle === 2, "answer with Aaron and Ada held");

    await server.send((client) =>
      client.DeleteNote(address(input.account, aaron.NoteId), { NoteId: aaron.NoteId }),
    );
    await until(() => !list.has(aaron.NoteId), "removal delivered");
    await server.indexed((stored) => !stored.has(aaron.NoteId));
    release();
    await tick();
    expect(titles(page)).toEqual(["n1:Ada", "n2:Bob"]);

    await Effect.runPromise(clock.adjust(10));
    await until(() => countAsked(server).NotesByTitle === 3, "corrective answer");
    await tick();
    expect(titles(page)).toEqual(["n1:Ada", "n2:Bob"]);
    expect(shown).not.toContain("-");
  });

  it("f(page, three stale answers in a row) → publishes the third with later changes", async () => {
    const server = await open();
    await seed(server, ada, bob);
    const clock = await manualClock();
    const db = account(server, input.account, cleanup, { clock });
    const page = observe(db, notes.page(input), cleanup);
    await ready(page);

    const aaron = { ...ada, NoteId: "n4", title: "Aaron" };
    await seed(server, aaron);
    HighAlch.reload(db, NoteRows);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const release = server.hold();
      await Effect.runPromise(clock.adjust(10));
      await until(() => countAsked(server).NotesByTitle === attempt + 1, "held stale answer");
      const title = `Ada ${attempt}`;

      await server.send((client) =>
        client.RenameNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId, title }),
      );
      await until(() => page.get(ada.NoteId)?.title === title, "later rename delivered");
      await server.indexed((stored) => stored.get(ada.NoteId)?.title === title);
      release();
      if (attempt < 3) {
        await tick();
        expect(titles(page)).toEqual([`n1:${title}`, "n2:Bob"]);
      }
    }

    await until(() => page.has(aaron.NoteId), "third stale answer accepted");
    expect(titles(page)).toEqual(["n1:Ada 3", "n4:Aaron"]);
    expect(countAsked(server).NotesByTitle).toBe(4);
  });

  it.each(["explicit reload", "feed change"])(
    "f(retry waiting, %s) → re-asks after the debounce",
    async (reason) => {
      const server = await open();
      await seed(server, ada, bob);
      const clock = await manualClock();
      const api = server.wire.client;
      let fail = false;
      const db = account(server, input.account, cleanup, {
        clock,
        retry: retryTransport(60_000, 1),
        layer: Layer.succeed(NotesApi.Client, {
          ...api,
          NotesByTitle: (query, options) =>
            api.NotesByTitle(query, options).pipe(
              Effect.flatMap((answer) => {
                if (fail) return Effect.fail(transport());

                return Effect.succeed(answer);
              }),
            ),
        }),
      });
      const page = observe(db, notes.page(input), cleanup);
      await ready(page);

      fail = true;
      HighAlch.reload(db, NoteRows);
      await Effect.runPromise(clock.adjust(10));
      await until(() => page.health.failureReason !== null, "reload waiting to retry");
      expect(countAsked(server).NotesByTitle).toBe(2);

      fail = false;
      if (reason === "explicit reload") HighAlch.reload(db, NoteRows);
      else {
        await server.send((client) =>
          client.RenameNote(address(input.account, ada.NoteId), {
            NoteId: ada.NoteId,
            title: "Abel",
          }),
        );
        await until(() => page.get(ada.NoteId)?.title === "Abel", "rename delivered");
      }

      await Effect.runPromise(clock.adjust(9));
      expect(countAsked(server).NotesByTitle).toBe(2);
      await Effect.runPromise(clock.adjust(1));
      await until(() => page.health.failureReason === null, "recovered before retry delay");
      expect(countAsked(server).NotesByTitle).toBe(3);
      await Effect.runPromise(clock.adjust(60_000));
      expect(countAsked(server).NotesByTitle).toBe(3);

      fail = true;
      HighAlch.reload(db, NoteRows);
      await Effect.runPromise(clock.adjust(10));
      await until(() => page.health.failureReason !== null, "another reload waiting to retry");
      HighAlch.reload(db, NoteRows);
      await Effect.runPromise(clock.adjust(10));
      await until(() => countAsked(server).NotesByTitle === 5, "preempted attempt failed again");
      await tick();

      // A preempted failure restarts the backoff. It cannot retry at time zero.
      fail = false;
      await Effect.runPromise(clock.adjust(59_999));
      expect(countAsked(server).NotesByTitle).toBe(5);
      await Effect.runPromise(clock.adjust(1));
      await until(() => page.health.failureReason === null, "retried after the first delay");
      expect(countAsked(server).NotesByTitle).toBe(6);
    },
  );
});

describe("f(offset/limit page, feed change)", () => {
  const input = { account: "acc-1", Offset: 0, Limit: 2 };

  const observePage = (db: DbClient) => observe<Note>(db, notes.page(input), cleanup);

  it("f(page, held row removed) → gone immediately; the lookahead row backfills", async () => {
    const server = await open();

    await seed(server, ada, bob, cyd);

    const clock = reloads();
    const db = account(server, input.account, cleanup, { clock: clock.clock });
    const page = observePage(db);

    await ready(page);
    expect(titles(page)).toEqual(["n1:Ada", "n2:Bob"]);
    const asked = countAsked(server).NotesByTitle;

    await server.send((client) =>
      client.DeleteNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId }),
    );
    await until(() => !page.has(ada.NoteId), "row removed");
    await server.indexed((stored) => !stored.has(ada.NoteId));

    expect(titles(page)).toEqual(["n2:Bob"]);
    expect(countAsked(server).NotesByTitle).toBe(asked);

    const release = server.hold();

    clock.advance();
    await until(() => countAsked(server).NotesByTitle > asked, "page reload asked");

    expect(page.isReady()).toBe(true);
    expect(titles(page)).toEqual(["n2:Bob"]);

    release();
    await until(() => page.has(cyd.NoteId), "lookahead backfilled");

    expect(titles(page)).toEqual(["n2:Bob", "n3:Cyd"]);
    expect(countAsked(server).NotesByTitle).toBe(asked + 1);
  });

  it("f(page, held row renamed) → updated in place; the answer moves the row out at the correction cap", async () => {
    const server = await open();

    await seed(server, ada, bob, cyd);

    const clock = reloads();
    const db = account(server, input.account, cleanup, { clock: clock.clock });
    const page = observePage(db);

    await ready(page);
    const asked = countAsked(server).NotesByTitle;

    await server.send((client) =>
      client.RenameNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId, title: "Zed" }),
    );
    await until(() => page.get(ada.NoteId)?.title === "Zed", "renamed in place");
    await server.indexed((stored) => stored.get(ada.NoteId)?.title === "Zed");

    clock.advance();
    await until(() => page.has(cyd.NoteId), "page reordered");

    expect(titles(page)).toEqual(["n1:Zed", "n2:Bob", "n3:Cyd"]);
    for (let index = 2; index <= 4; index += 1) {
      clock.advance();
      await until(() => countAsked(server).NotesByTitle === asked + index, "correction sent");
      await tick();
    }

    expect(titles(page)).toEqual(["n2:Bob", "n3:Cyd"]);
    expect(countAsked(server).NotesByTitle).toBe(asked + 4);
  });

  it("f(page, unknown row enters before the end) → the query places it after one reload", async () => {
    const server = await open();

    await seed(server, bob, cyd);

    const db = account(server, input.account, cleanup);
    const page = observePage(db);

    await ready(page);
    await seed(server, ada);
    await until(() => page.has(ada.NoteId), "unknown row placed");

    expect(titles(page)).toEqual(["n1:Ada", "n2:Bob"]);
    expect(countAsked(server).NotesByTitle).toBe(2);
  });

  it("f(page, three entries and an explicit reload inside the delay) → one query", async () => {
    const server = await open();

    await seed(server, ada, bob, cyd);

    const clock = reloads();
    const db = account(server, input.account, cleanup, { clock: clock.clock });
    const page = observePage(db);

    await ready(page);

    for (const title of ["Ada 2", "Ada 3", "Zed"]) {
      await server.send((client) =>
        client.RenameNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId, title }),
      );
      await until(() => page.get(ada.NoteId)?.title === title, title);
    }

    HighAlch.reload(db, NoteRows);
    await server.indexed((stored) => stored.get(ada.NoteId)?.title === "Zed");
    expect(countAsked(server).NotesByTitle).toBe(1);

    clock.advance();
    await until(() => page.has(cyd.NoteId), "page reordered");

    expect(countAsked(server).NotesByTitle).toBe(2);
  });

  it("f(page loading, a held row is renamed) → the buffered change triggers a fresh answer", async () => {
    const server = await open();

    await seed(server, ada, bob, cyd);

    const clock = reloads();
    const db = account(server, input.account, cleanup, { clock: clock.clock });
    const witness = observe<Note>(db, notes.get({ NoteId: ada.NoteId }), cleanup);

    await ready(witness);
    const release = server.hold();
    const page = observePage(db);

    await until(() => countAsked(server).NotesByTitle === 1, "first answer held");

    await server.send((client) =>
      client.RenameNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId, title: "Zed" }),
    );
    await until(() => witness.get(ada.NoteId)?.title === "Zed", "feed delivered during load");
    await server.indexed((stored) => stored.get(ada.NoteId)?.title === "Zed");

    release();
    await ready(page);
    expect(titles(page)).toEqual(["n1:Zed", "n2:Bob"]);

    clock.advance();
    await until(() => page.has(cyd.NoteId), "page reordered");

    expect(titles(page)).toEqual(["n1:Zed", "n2:Bob", "n3:Cyd"]);
    for (let index = 3; index <= 5; index += 1) {
      clock.advance();
      await until(() => countAsked(server).NotesByTitle === index, "correction sent");
      await tick();
    }

    expect(titles(page)).toEqual(["n2:Bob", "n3:Cyd"]);
    expect(countAsked(server).NotesByTitle).toBe(5);
  });

  it.each([false, true])(
    "f(page, optimistic insert confirmed by cause) → visible until the correction cap (query already in flight: %s)",
    async (inFlight) => {
      const server = await open();

      await seed(server, ada, bob);

      const clock = reloads();
      const cause = "page-insert";
      const committed = Promise.withResolvers<HighAlch.Settled<unknown>>();
      const db = account(server, input.account, cleanup, {
        clock: clock.clock,
        layer: causeLayer(server, cause),
      });
      const page = observePage(db);

      await ready(page);

      let release = server.hold();

      if (inFlight) {
        HighAlch.reload(db, NoteRows);
        clock.advance();
        await until(() => countAsked(server).NotesByTitle === 2, "older query held");
      }

      const inserted = notes.create.with({ client: db })(
        { account: input.account, BookId: "b1", title: "Zed" },
        { id: cause, onCommitted: committed.resolve },
      );
      const key = HighAlch.created(inserted);
      const seen: Array<string | undefined> = [];
      const subscription = page.subscribeChanges(() => seen.push(page.get(key)?.title));

      cleanup.push(async () => subscription.unsubscribe());

      expect(page.get(key)?.title).toBe("Zed");
      await inserted.when("settled");
      expect(await committed.promise).toMatchObject({ _tag: "Committed" });
      await server.indexed((stored) => stored.has(key));
      expect(page.get(key)?.title).toBe("Zed");

      const asked = countAsked(server).NotesByTitle;

      clock.advance();

      if (inFlight) {
        await tick();
        expect(countAsked(server).NotesByTitle).toBe(asked);
        release();
        release = server.hold();
      }

      await until(() => countAsked(server).NotesByTitle === asked + 1, "corrective query held");
      expect(page.get(key)?.title).toBe("Zed");
      expect(seen).not.toContain(undefined);

      release();
      await tick();
      expect(page.get(key)?.title).toBe("Zed");
      for (let index = 2; index <= 4; index += 1) {
        clock.advance();
        await until(() => countAsked(server).NotesByTitle === asked + index, "correction sent");
        await tick();
      }
      await until(() => !page.has(key), "insert excluded at the correction cap");

      expect(titles(page)).toEqual(["n1:Ada", "n2:Bob"]);
      expect(seen.filter((value) => value === undefined)).toEqual([undefined]);
      expect(countAsked(server).NotesByTitle).toBe(asked + 4);
    },
  );

  it("f(page reloading, a held row the older answer drops is renamed again) → it stays until the next answer", async () => {
    const server = await open();

    await seed(server, ada, bob, cyd);

    const clock = reloads();
    const db = account(server, input.account, cleanup, { clock: clock.clock });
    const page = observePage(db);

    await ready(page);

    const seen: Array<string | undefined> = [];
    const subscription = page.subscribeChanges(() => seen.push(page.get(ada.NoteId)?.title));

    cleanup.push(async () => subscription.unsubscribe());

    const rename = async (title: string) => {
      await server.send((client) =>
        client.RenameNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId, title }),
      );
      await until(() => page.get(ada.NoteId)?.title === title, title);
      await server.indexed((stored) => stored.get(ada.NoteId)?.title === title);
    };

    await rename("Zed");

    // The older answer, asked while the note is Zed, places it outside the page.
    const release = server.hold();

    clock.advance();
    await until(() => countAsked(server).NotesByTitle === 2, "older query held");
    await rename("Abel");

    release();
    await tick();
    expect(page.get(ada.NoteId)?.title).toBe("Abel");

    clock.advance();
    await until(() => countAsked(server).NotesByTitle === 3, "corrective query asked");
    await tick();

    expect(titles(page)).toEqual(["n1:Abel", "n2:Bob"]);
    expect(seen).not.toContain(undefined);
  });

  it("f(page reloading, one change's delay passes, then another change) → one more query, not two", async () => {
    const server = await open();

    await seed(server, ada, bob, cyd);

    const clock = reloads();
    const db = account(server, input.account, cleanup, { clock: clock.clock });
    const page = observePage(db);

    await ready(page);

    const rename = async (title: string) => {
      await server.send((client) =>
        client.RenameNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId, title }),
      );
      await until(() => page.get(ada.NoteId)?.title === title, title);
      await server.indexed((stored) => stored.get(ada.NoteId)?.title === title);
    };

    await rename("Ada 2");

    const release = server.hold();

    clock.advance();
    await until(() => countAsked(server).NotesByTitle === 2, "first reload held");

    // Its delay passes while the first reload is in flight; the next change schedules again.
    await rename("Ada 3");
    clock.advance();
    await rename("Ada 4");

    release();
    await until(() => countAsked(server).NotesByTitle === 3, "follow-up reload asked");

    clock.advance();
    await tick();
    await tick();

    expect(countAsked(server).NotesByTitle).toBe(3);
    expect(titles(page)).toEqual(["n1:Ada 4", "n2:Bob"]);
  });

  it("f(page reloading, change covered by the reload cursor) → the answer needs no follow-up", async () => {
    const server = await open();

    await seed(server, ada, bob, cyd);

    const clock = reloads();
    const api = server.wire.client;
    const gate = Promise.withResolvers<void>();
    let holdCursor = false;
    let readingCursor = false;
    const db = account(server, input.account, cleanup, {
      clock: clock.clock,
      layer: Layer.succeed(NotesApi.Client, {
        ...api,
        NotebookChanges: {
          ...api.NotebookChanges,
          peek: (key, options) =>
            Effect.gen(function* () {
              if (holdCursor) {
                readingCursor = true;
                yield* Effect.promise(() => gate.promise);
              }

              return yield* api.NotebookChanges.peek(key, options);
            }),
        },
      }),
    });
    const page = observePage(db);

    await ready(page);
    holdCursor = true;
    HighAlch.reload(db, NoteRows);
    clock.advance();
    await until(() => readingCursor, "reload waiting to read cursor");

    await server.send((client) =>
      client.RenameNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId, title: "Zed" }),
    );
    await until(() => page.get(ada.NoteId)?.title === "Zed", "rename before cursor read");
    await server.indexed((stored) => stored.get(ada.NoteId)?.title === "Zed");
    clock.advance();

    gate.resolve();
    await until(() => page.has(cyd.NoteId), "answer includes the rename");
    clock.advance();
    await tick();

    expect(titles(page)).toEqual(["n2:Bob", "n3:Cyd"]);
    expect(countAsked(server).NotesByTitle).toBe(2);
  });

  it("f(later page, row on earlier page removed) → one re-ask shifts the live page", async () => {
    const server = await open();

    const dan = { ...ada, NoteId: "n4", title: "Dan" };

    await seed(server, ada, bob, cyd, dan);

    const clock = reloads();
    const db = account(server, input.account, cleanup, { clock: clock.clock });
    const rendering = account(server, input.account, cleanup, {
      live: false,
      clock: clock.clock,
    });
    const source = notes.page({ ...input, Offset: 1 });
    const page = observe<Note>(db, source, cleanup);
    const snapshot = observe<Note>(rendering, source, cleanup);
    const witness = observe<Note>(db, notes.get({ NoteId: ada.NoteId }), cleanup);

    await ready(page, snapshot, witness);
    expect(titles(page)).toEqual(["n2:Bob", "n3:Cyd"]);

    await server.send((client) =>
      client.DeleteNote(address(input.account, ada.NoteId), { NoteId: ada.NoteId }),
    );
    await until(() => !witness.has(ada.NoteId), "earlier removal delivered");
    await server.indexed((stored) => !stored.has(ada.NoteId));
    expect(titles(page)).toEqual(["n2:Bob", "n3:Cyd"]);
    expect(countAsked(server).NotesByTitle).toBe(2);

    clock.advance();
    await until(() => page.has(dan.NoteId), "page shifted");

    expect(titles(page)).toEqual(["n3:Cyd", "n4:Dan"]);
    expect(titles(snapshot)).toEqual(["n2:Bob", "n3:Cyd"]);
    expect(countAsked(server).NotesByTitle).toBe(3);
    expect(server.wire.counts.open).toBe(1);
  });

  it.each([
    { action: "rename", optimistic: "Abel", rows: ["n1:Abel", "n2:Bob"] },
    { action: "remove", optimistic: undefined, rows: ["n2:Bob", "n3:Cyd"] },
  ])(
    "f(page, optimistic $action confirmed by cause) → no flicker through one re-ask",
    async ({ action, optimistic, rows }) => {
      const server = await open();

      await seed(server, ada, bob, cyd);

      const clock = reloads();
      const cause = `page-${action}`;
      const committed = Promise.withResolvers<HighAlch.Settled<unknown>>();
      const db = account(server, input.account, cleanup, {
        clock: clock.clock,
        layer: causeLayer(server, cause),
      });
      const page = observePage(db);

      await ready(page);

      const seen: Array<string | undefined> = [];
      const subscription = page.subscribeChanges(() => seen.push(page.get(ada.NoteId)?.title), {
        includeInitialState: false,
      });

      cleanup.push(async () => subscription.unsubscribe());
      const options = {
        id: cause,
        onCommitted: committed.resolve,
      };
      const command = Option.match(Option.fromUndefinedOr(optimistic), {
        onSome: (title) =>
          notes.rename.with({ client: db })({ NoteId: ada.NoteId, title }, options),
        onNone: () => notes.remove.with({ client: db })({ NoteId: ada.NoteId }, options),
      });

      expect(page.get(ada.NoteId)?.title).toBe(optimistic);
      await command.when("settled");
      expect(await committed.promise).toMatchObject({ _tag: "Committed" });
      expect(page.get(ada.NoteId)?.title).toBe(optimistic);
      await server.indexed((stored) => stored.get(ada.NoteId)?.title === optimistic);

      const release = server.hold();

      clock.advance();
      await until(() => countAsked(server).NotesByTitle === 2, "corrective query held");
      expect(page.isReady()).toBe(true);
      expect(page.get(ada.NoteId)?.title).toBe(optimistic);
      release();
      await tick();
      clock.advance();
      await tick();

      expect(titles(page)).toEqual(rows);
      expect(seen.length).toBeGreaterThan(0);
      expect([...new Set(seen)]).toEqual([optimistic]);
      expect(countAsked(server).NotesByTitle).toBe(2);
    },
  );
});

describe("f(ready subsets, command)", () => {
  it("f(subsets, insert/update/custom edit/delete) → optimistic in every subset that shows the row, then committed", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);
    const { list, one, book } = subsets(db);
    const create = notes.create.with({ client: db });

    await ready(list, one, book);

    const created = create({ account: "acc-1", BookId: "b2", title: "Cyd" });
    const n3 = HighAlch.created(created);

    // Optimistic at once under a fresh client-generated key: in the whole list, not in
    // book b1 (its rule refuses b2).
    expect(n3).toMatch(/^[0-9a-f-]{36}$/);
    expect(list.get(n3)?.title).toBe("Cyd");
    expect(book.has(n3)).toBe(false);

    await created.when("settled");

    // The server created the note under the same key, addressed through the entity's target.
    expect(created.state).toBe("completed");
    expect(list.get(n3)?.title).toBe("Cyd");
    await server.indexed((stored) => stored.get(n3)?.title === "Cyd");
    expect(server.wire.counts.targets).toContain(`CreateNote ${address("acc-1", n3)}`);

    const renamed = notes.rename.with({ client: db })({ NoteId: "n1", title: "Ada 2" });

    expect([list, one, book].map((each) => each.get("n1")?.title)).toEqual([
      "Ada 2",
      "Ada 2",
      "Ada 2",
    ]);

    await renamed.when("settled");

    const pinned = notes.pin.with({ client: db })({ NoteId: "n1", pinned: true });

    expect(one.get("n1")?.pinned).toBe(true);

    await pinned.when("settled");

    const removed = notes.remove.with({ client: db })({ NoteId: "n2" });

    expect(list.has("n2")).toBe(false);

    await removed.when("settled");
    await tick(30);

    expect(titles(list)).toEqual(["n1:Ada 2", `${n3}:Cyd`].sort());
    expect(one.get("n1")).toMatchObject({ title: "Ada 2", pinned: true });
    expect(server.store.notes.get("n1")).toMatchObject({ title: "Ada 2", pinned: true });
    await server.indexed((stored) => !stored.has("n2"));
  });

  it("f(ready, rename) → observed values go optimistic → committed, never back; settled after the feed", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const { list, one } = subsets(db);

    await ready(list, one);

    const inList = history(list, "n1", (note) => note.title);
    const inOne = history(one, "n1", (note) => note.title);

    const transaction = notes.rename.with({ client: db })({ NoteId: "n1", title: "Ada 2" });

    await transaction.when("settled");

    expect(one.get("n1")?.title).toBe("Ada 2");

    await tick(50);

    expect(inList.every((title) => title === "Ada 2")).toBe(true);
    expect(inOne.every((title) => title === "Ada 2")).toBe(true);
    expect(inList.length).toBeGreaterThan(0);
  });

  it("f(ready, rejected rename) → rolled back; the original rejection reaches onRejected, when, effect and result", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);
    const seen: Array<unknown> = [];

    await ready(one);

    const rename = notes.rename.with({ client: db });
    const locked = { NoteId: "n1", title: "locked" };

    const transaction = rename(locked, {
      onRejected: {
        NoteLocked: (error) => seen.push(error),
        orElse: () => seen.push("other"),
      },
    });

    expect(one.get("n1")?.title).toBe("locked");

    const rejection = await transaction.when("settled").then(
      () => undefined,
      (cause) => cause,
    );

    expect(rejection).toBeInstanceOf(NoteLocked);
    expect(transaction.state).toBe("failed");
    expect(one.get("n1")?.title).toBe("Ada");
    await until(() => seen.length === 1, "onRejected");
    expect(seen[0]).toBe(rejection);

    const failed = await Effect.runPromise(Effect.flip(rename.effect(locked)));

    expect(failed).toBeInstanceOf(NoteLocked);

    const result = await rename.result(locked);

    const shown = HighAlch.match(result).on({
      Committed: () => "committed",
      Unconfirmed: () => "unconfirmed",
      NoteLocked: (error) => `locked:${error.title}`,
      NoteMissing: () => "missing",
      RpcClientError: () => "transport",
    });

    expect(shown).toBe("locked:locked");
  });

  it("f(feed silent, command) → Unconfirmed after the settle timeout; its subsets reload", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup, { settleTimeout: 100 });
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);

    await ready(one);
    server.wire.mute(true);

    const outcome = await notes.rename
      .with({ client: db })
      .result({ NoteId: "n1", title: "Ada 2" });

    server.wire.mute(false);

    expect(Predicate.isTagged(outcome, "Unconfirmed")).toBe(true);

    await until(() => one.get("n1")?.title === "Ada 2", "reload");
  });

  it("f(entity command that changes nothing) → settles at once from the stream's cursor, no timeout", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup, { settleTimeout: 5_000 });
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);

    await ready(one);

    const started = Date.now();
    const outcome = await notes.touch.with({ client: db }).result({ NoteId: "n1" });

    expect(outcome).toMatchObject({ _tag: "Committed", reply: { touched: true } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("f(no rows, command(Touch)) → the transaction settles when the command returns", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const values: Array<unknown> = [];

    const transaction = touch.with({ client: db, onCommitted: (value) => values.push(value) })({
      NoteId: "n1",
    });

    await transaction.when("settled");
    await until(() => values.length === 1, "onCommitted");

    expect(values[0]).toMatchObject({ _tag: "Committed", reply: { touched: true } });
  });

  it("f(subsets, createOptimisticAction(command.options)) → optimistic, then committed by the feed", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);
    const release = HighAlch.activate(db);

    cleanup.push(async () => release());
    await ready(one);

    const pin = createOptimisticAction(notes.pin.options);
    const transaction = pin({ NoteId: "n1", pinned: true });

    expect(one.get("n1")?.pinned).toBe(true);

    await transaction.when("settled");

    expect(one.get("n1")?.pinned).toBe(true);
    await server.indexed((stored) => stored.get("n1")?.pinned === true);
  });

  it("f(no active client, command) → fails loudly", () => {
    expect(() => notes.rename({ NoteId: "n1", title: "x" })).toThrow(
      /No HighAlch client is active/,
    );
    // The scope (and so the target) is unknown without a client: a create fails the same way.
    expect(() => notes.create({ account: "acc-1", BookId: "b1", title: "x" })).toThrow(
      /No HighAlch client is active/,
    );
  });

  it("f(paced updates, three calls) → one transaction, one command, the last value", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);
    const release = HighAlch.activate(db);

    cleanup.push(async () => release());
    await ready(one);

    const mutate = createPacedMutations({
      ...notes.rename.paced,
      strategy: debounceStrategy({ wait: 20 }),
    });

    const calls = ["A", "Ad", "Ada 3"].map((title) => mutate({ NoteId: "n1", title }));

    expect(new Set(calls).size).toBe(1);
    expect(one.get("n1")?.title).toBe("Ada 3");

    await calls[0]?.when("settled");

    expect(server.wire.counts.commands.filter((name) => name === "RenameNote")).toHaveLength(1);
    expect(server.wire.counts.targets).toContain(`RenameNote ${address("acc-1", "n1")}`);
    await server.indexed((stored) => stored.get("n1")?.title === "Ada 3");
    expect(one.get("n1")?.title).toBe("Ada 3");
  });

  it("f(paced updates, a changed and an unchanged field) → the input reads only the key and the changed fields; an unchanged save sends nothing", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);
    const release = HighAlch.activate(db);

    cleanup.push(async () => release());
    await ready(one);

    const read: Array<Partial<Note>> = [];

    const saved = HighAlch.collection(NoteRows, {
      queries: { list: HighAlch.read(Notes).all() },
      commands: {
        rename: HighAlch.updates(RenameNote, {
          // A call also sets the note's book, as a form sends every field it shows.
          fields: (input) => ({ ...input, BookId: "b1" }),
          input: (row: Partial<Note>) => {
            read.push(row);

            return { NoteId: String(row.NoteId), title: String(row.title) };
          },
        }),
      },
    });

    const mutate = createPacedMutations({
      ...saved.rename.paced,
      strategy: debounceStrategy({ wait: 20 }),
    });

    // The call sets `title` and `BookId`; only the title differs from the row.
    await mutate({ NoteId: "n1", title: "Ada 2" }).when("settled");

    expect(read).toEqual([{ NoteId: "n1", title: "Ada 2" }]);
    await server.indexed((stored) => stored.get("n1")?.title === "Ada 2");

    // Nothing differs: no mutation, so no command.
    await mutate({ NoteId: "n1", title: "Ada 2" }).when("settled");

    expect(read).toHaveLength(1);
    expect(server.wire.counts.commands.filter((name) => name === "RenameNote")).toHaveLength(1);
  });
});

describe("f(declared targets, input-only command)", () => {
  it("f(two entities, one client) → each command addresses its own entity's target", async () => {
    const server = await open();

    await seed(server, ada);
    await server.send((client) => client.CreateBook("k1", { account: "acc-1", name: "Poems" }));
    await until(() => server.store.books.has("k1"), "book indexed");

    const db = account(server, "acc-1", cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);
    const shelf = observe<Book>(db, books.list({ account: "acc-1" }), cleanup);

    await ready(one, shelf);

    const renamed = notes.rename.with({ client: db })({ NoteId: "n1", title: "Ada 2" });
    const retitled = books.rename.with({ client: db })({ BookId: "k1", name: "Prose" });

    expect(one.get("n1")?.title).toBe("Ada 2");
    expect(shelf.get("k1")?.name).toBe("Prose");

    await Promise.all([renamed.when("settled"), retitled.when("settled")]);

    // NoteRows declares `[scope, key]`; BookRows declares nothing, so the key is the target.
    expect(server.wire.counts.targets).toEqual([
      `RenameNote ${address("acc-1", "n1")}`,
      "RenameBook k1",
    ]);
    await until(() => server.store.books.get("k1")?.name === "Prose", "book renamed");

    const shelved = books.create.with({ client: db })({ account: "acc-1", name: "Essays" });
    const k2 = HighAlch.created(shelved);

    expect(shelf.get(k2)?.name).toBe("Essays");

    await shelved.when("settled");

    expect(server.wire.counts.targets).toContain(`CreateBook ${k2}`);
    await until(() => server.store.books.get(k2)?.name === "Essays", "book created");
  });

  it("f(per-command target, call) → it takes precedence over the entity's; the key still names the row", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);

    // Declared next to the entity's target: touching a note addresses the note `n2` instead.
    const elsewhere = HighAlch.collection(NoteRows, {
      queries: { list: HighAlch.read(Notes).all() },
      commands: {
        touch: HighAlch.sends(TouchNote, { target: (_input, scope) => address(scope, "n2") }),
        rename: HighAlch.updates(RenameNote, {
          target: (input, scope) => address(scope, input.NoteId.toLowerCase()),
        }),
      },
    });

    const list = observe<Note>(db, elsewhere.list({ account: "acc-1" }), cleanup);

    await ready(list);

    await elsewhere.touch.with({ client: db })({ NoteId: "n1" }).when("settled");

    const renamed = elsewhere.rename.with({ client: db })({ NoteId: "N1", title: "Upper" });

    // The optimistic edit follows the input's key field; the command, its own target.
    expect(list.has("N1")).toBe(false);

    await renamed.when("settled");

    expect(server.wire.counts.targets).toEqual([
      `TouchNote ${address("acc-1", "n2")}`,
      `RenameNote ${address("acc-1", "n1")}`,
    ]);
    await server.indexed((stored) => stored.get("n1")?.title === "Upper");
  });

  it("f(inserts with a declared key, call) → the row and the server use the key read from the input", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const book = observe<Note>(db, notes.byBook({ BookId: "b1" }), cleanup);

    await ready(book);

    const filed = notes.file.with({ client: db })({ account: "acc-1", BookId: "b1", title: "Cyd" });

    expect(HighAlch.created(filed)).toBe("b1:Cyd");
    expect(book.get("b1:Cyd")?.title).toBe("Cyd");

    await filed.when("settled");

    expect(server.wire.counts.targets).toEqual([`CreateNote ${address("acc-1", "b1:Cyd")}`]);
    await server.indexed((stored) => stored.get("b1:Cyd")?.BookId === "b1");
  });

  it("f(createOptimisticAction(inserts.options), call) → the key chosen in onMutate is the one sent", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const list = observe<Note>(db, notes.list({ account: "acc-1" }), cleanup);
    const release = HighAlch.activate(db);

    cleanup.push(async () => release());
    await ready(list);

    const create = createOptimisticAction(notes.create.options);
    const transaction = create({ account: "acc-1", BookId: "b1", title: "Dee" });
    const key = String(transaction.metadata[HighAlch.createdKey]);

    expect(list.get(key)?.title).toBe("Dee");

    await transaction.when("settled");

    expect(server.wire.counts.targets).toEqual([`CreateNote ${address("acc-1", key)}`]);
    expect(list.get(key)?.title).toBe("Dee");
  });
});

describe("f(feed, failure)", () => {
  it.each(["reload", "command"])(
    "f(failed subset cleaned after a healthy subset registers, %s) → still reaches the healthy subset",
    async (action) => {
      const server = await open();
      await seed(server, ada);
      const clock = await manualClock();
      const db = account(server, ada.account, cleanup, { clock });
      const failed = observe(
        db,
        notes.page({ account: ada.account, Offset: 0, Limit: 2 }),
        cleanup,
      );
      await ready(failed);
      server.store.refuse.add("NotesByTitle");
      HighAlch.reload(db, NoteRows);
      await Effect.runPromise(clock.adjust(10));
      await until(() => failed.health.error !== null, "page failed");
      expect(countAsked(server).NotesByTitle).toBe(2);

      const healthy = observe(db, notes.get({ NoteId: ada.NoteId }), cleanup);
      await ready(healthy);
      await failed.cleanup();

      if (action === "reload") {
        HighAlch.reload(db, NoteRows);
        await Effect.runPromise(clock.adjust(10));
        await tick();
        expect(countAsked(server).NoteById).toBe(2);
      } else {
        const tx = notes.rename.with({ client: db })({ NoteId: ada.NoteId, title: "Abel" });
        expect(healthy.get(ada.NoteId)?.title).toBe("Abel");
        await tx.when("settled");
      }
      expect(countAsked(server).NotesByTitle).toBe(2);
    },
  );

  it("f(ready, feed cut) → reportError (failureReason), then recovery from the last seq", async () => {
    const server = await open();

    await seed(server, ada);

    const retry = retryTransport(60, 3);

    const db = account(server, "acc-1", cleanup, { retry });
    const book = observe<Note>(db, notes.byBook({ BookId: "b1" }), cleanup);

    await ready(book);

    const before = { peeks: server.wire.counts.peeks, asked: server.store.asked.length };

    server.wire.refuse(1);
    server.wire.cut();
    await until(() => book.health.failureReason !== null, "failureReason");

    expect(book.health.failureReason?.cause).toMatchObject({ _tag: "RpcClientError" });

    // Written while the feed is down: delivered after it resumes from its last seq.
    await server.send((client) =>
      client.CreateNote(address("acc-1", "n4"), { account: "acc-1", BookId: "b1", title: "Dee" }),
    );

    await until(() => book.health.failureReason === null && book.has("n4"), "recovered");

    expect(titles(book)).toEqual(["n1:Ada", "n4:Dee"]);

    // Resumed after the last applied seq: no new cursor read, no reload; the rule placed n4.
    expect(server.wire.counts.peeks).toBe(before.peeks);
    expect(server.store.asked).toHaveLength(before.asked);
    expect(server.wire.counts.connections).toBeGreaterThanOrEqual(3);
  });

  it("f(ready, feed gives up) → rows stay; the collection's error holds the cause", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const book = observe<Note>(db, notes.byBook({ BookId: "b1" }), cleanup);

    await ready(book);

    server.wire.refuse(5);
    server.wire.cut(transport());
    await until(() => book.health.error !== null, "stopped");

    expect(book.isReady()).toBe(true);
    expect(titles(book)).toEqual(["n1:Ada"]);
  });

  it("f(three subsets, cleanup) → the shared feed subscription is released", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const { list, one, book } = subsets(db);

    await ready(list, one, book);

    expect(server.wire.counts.open).toBe(1);

    await db.cleanup();
    await until(() => server.wire.counts.open === 0, "released");

    expect(server.wire.counts.open).toBe(0);
  });
});

describe("f(one feed, two entities)", () => {
  it("f(feed, Projection over its entities) → the one writer of that feed class, keyed like it", () => {
    expect(NotebookWriter.definition.writes).toEqual([NotebookChanges]);
    expect(NotebookWriter.definition.writes?.[0]).toBe(NotebookChanges);
    expect(NotebookWriter.definition.key).toBe(NotebookChanges.feed.scope);
    expect(NotebookWriter.entities).toEqual([NoteRows, BookRows]);
  });

  it("f(notes and books subsets, server changes to both) → one subscription; each entity's subsets get only their rows", async () => {
    const server = await open();

    await seed(server, ada);
    await server.send((client) => client.CreateBook("k1", { account: "acc-1", name: "Poems" }));

    const db = account(server, "acc-1", cleanup);
    const { list, one, book } = subsets(db);
    const shelf = observe<Book>(db, books.list({ account: "acc-1" }), cleanup);

    await ready(list, one, book, shelf);

    expect(server.wire.counts.open).toBe(1);

    await server.send((client) => client.RenameBook("k1", { BookId: "k1", name: "Prose" }));
    await server.send((client) =>
      client.RenameNote(address("acc-1", "n1"), { NoteId: "n1", title: "Ada 2" }),
    );
    await until(
      () => shelf.get("k1")?.name === "Prose" && one.get("n1")?.title === "Ada 2",
      "both entities",
    );

    // A book entry never reaches a notes subset, nor a note entry the books subset.
    expect([...list.keys()]).toEqual(["n1"]);
    expect([...shelf.keys()]).toEqual(["k1"]);

    // Releasing every notes subset keeps the subscription for the books subset.
    await Promise.all([list.cleanup(), one.cleanup(), book.cleanup()]);
    await tick();

    expect(server.wire.counts.open).toBe(1);

    await server.send((client) => client.RenameBook("k1", { BookId: "k1", name: "Essays" }));
    await until(() => shelf.get("k1")?.name === "Essays", "books still follow");

    // The last subset of the last entity releases it.
    await shelf.cleanup();
    await until(() => server.wire.counts.open === 0, "released");
  });

  it("f(subscription live for notes, books subset added later) → it joins the same subscription and converges", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);

    await ready(one);

    // An entry of an entity nobody in this client reads yet passes by.
    await server.send((client) => client.CreateBook("k1", { account: "acc-1", name: "Poems" }));
    await until(() => server.store.books.has("k1"), "book indexed");
    await tick();

    const connections = server.wire.counts.connections;
    const shelf = observe<Book>(db, books.list({ account: "acc-1" }), cleanup);

    await ready(shelf);

    expect(shelf.get("k1")?.name).toBe("Poems");

    await server.send((client) => client.RenameBook("k1", { BookId: "k1", name: "Prose" }));
    await until(() => shelf.get("k1")?.name === "Prose", "book feed");

    // Same subscription: no new connection, one open feed.
    expect(server.wire.counts.connections).toBe(connections);
    expect(server.wire.counts.open).toBe(1);
  });

  it("f(ready subsets, every entry delivered twice) → each change applied once, in order", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);

    await ready(one);

    const seen = history(one, "n1", (note) => note.title);

    server.wire.repeat(true);

    for (const title of ["Ada 2", "Ada 3", "Ada 4"])
      await server.send((client) =>
        client.RenameNote(address("acc-1", "n1"), { NoteId: "n1", title }),
      );

    await until(() => one.get("n1")?.title === "Ada 4", "renamed");
    await tick(30);

    // Redelivered entries are dropped by their `seq`: one change per write, never back.
    expect(seen).toEqual(["Ada 2", "Ada 3", "Ada 4"]);

    // A command still settles on its (redelivered) change.
    const settled = await notes.rename
      .with({ client: db })
      .result({ NoteId: "n1", title: "Ada 5" });

    await tick(30);

    expect(settled).toMatchObject({ _tag: "Committed" });
    expect(seen.slice(3).every((title) => title === "Ada 5")).toBe(true);
  });
});

describe("f(deployment with history, feed projection added)", () => {
  it("f(notes written before the feed existed, deploy with the feed) → the projection replays them; a client converges and settles through the feed", async () => {
    const eve2 = { NoteId: "e2", account: "acc-2", BookId: "b1", title: "Eve 2" };
    const server = await host({ history: [ada, bob, eve, eve2] });

    cleanup.push(() => server.dispose());

    // The backfill appends every earlier change to its account's stream, once.
    for (let tries = 0; tries < 200; tries += 1) {
      const [first, second] = await Promise.all([server.entries("acc-1"), server.entries("acc-2")]);

      if (first.length === 2 && second.length === 2) break;

      await tick(10);
    }

    const replayed = await server.entries("acc-1");

    expect(replayed.map((entry) => [entry.envelope.seq, entry.event._tag])).toEqual([
      [1, "NotebookChanges.Upserted"],
      [2, "NotebookChanges.Upserted"],
    ]);
    expect(await server.entries("acc-2")).toHaveLength(2);

    const db = account(server, "acc-1", cleanup);
    const list = observe<Note>(db, notes.list({ account: "acc-1" }), cleanup);

    await ready(list);

    expect(titles(list)).toEqual(["n1:Ada", "n2:Bob"]);

    const outcome = await notes.rename
      .with({ client: db })
      .result({ NoteId: "n2", title: "Bob 2" });

    expect(outcome).toMatchObject({ _tag: "Committed" });
    expect(list.get("n2")?.title).toBe("Bob 2");
    expect((await server.entries("acc-1", 2)).map((entry) => entry.envelope.seq)).toEqual([3]);
  });
});

describe("f(non-entity query, load)", () => {
  it("f(standalone query started against a synchronous endpoint) → ready on a later turn", async () => {
    const server = await open();
    const runtime = ManagedRuntime.make(
      Layer.succeed(NotesApi.Client, {
        ...server.wire.client,
        NoteStats: () => Effect.succeed({ count: 3 }),
      }),
    );
    cleanup.push(() => runtime.dispose());
    await runtime.context();
    const db = account(server, ada.account, cleanup, { runtime });
    const summary = observe(db, stats({ account: ada.account }), cleanup);

    expect(summary.isReady()).toBe(false);
    await ready(summary);
    expect(summary.get("result")).toMatchObject({ count: 3 });
  });

  it.each([
    ["runtime", true],
    ["layer", true],
    ["runtime", false],
  ] as const)(
    "f(client built with a %s, Clock override %s) → endpoints see runtime context and the selected Clock",
    async (source, overrideClock) => {
      const server = await open();
      await seed(server, ada);
      const clock = await manualClock();
      const runtimeClock = await manualClock();
      const label = Context.Reference("test/lifecycle/label", { defaultValue: () => "default" });
      const api = server.wire.client;
      const seen: Array<readonly [string, string, number]> = [];
      const record = (endpoint: string) =>
        Effect.gen(function* () {
          seen.push([endpoint, yield* label, yield* Clock.currentTimeMillis]);
        });
      const layer = Layer.mergeAll(
        Layer.succeed(NotesApi.Client, {
          ...api,
          Notes: (...args) => record("query").pipe(Effect.andThen(api.Notes(...args))),
          RenameNote: (...args) => record("command").pipe(Effect.andThen(api.RenameNote(...args))),
          NotebookChanges: {
            ...api.NotebookChanges,
            peek: (...args) =>
              record("peek").pipe(Effect.andThen(api.NotebookChanges.peek(...args))),
            events: (...args) =>
              Stream.unwrap(record("events").pipe(Effect.as(api.NotebookChanges.events(...args)))),
          },
        }),
        Layer.succeed(label, "configured"),
        Layer.succeed(Clock.Clock, runtimeClock),
      );
      const runtime = ManagedRuntime.make(layer);
      cleanup.push(() => runtime.dispose());
      await Effect.runPromise(clock.adjust(123));
      await Effect.runPromise(runtimeClock.adjust(456));
      const config = source === "runtime" ? { runtime } : { layer };
      const db = account(server, ada.account, cleanup, {
        ...config,
        clock: Option.getOrUndefined(Option.liftPredicate(clock, () => overrideClock)),
      });
      const list = observe(db, notes.list({ account: ada.account }), cleanup);
      await ready(list);
      await notes.rename
        .with({ client: db })({ NoteId: ada.NoteId, title: "Abel" })
        .when("settled");

      expect(titles(list)).toEqual(["n1:Abel"]);
      expect(new Set(seen.map(([endpoint]) => endpoint))).toEqual(
        new Set(["query", "command", "peek", "events"]),
      );
      expect([...new Set(seen.map(([, value]) => value))]).toEqual(["configured"]);
      expect([...new Set(seen.map(([, , time]) => time))]).toEqual([overrideClock ? 123 : 456]);
    },
  );

  it.each(["entity", "standalone", "feed"] as const)(
    "f(%s endpoint interrupts itself, observe) → fails the load with a HighAlch defect",
    async (endpoint) => {
      const server = await open();
      const api = server.wire.client;
      const db = account(server, ada.account, cleanup, {
        layer: Layer.succeed(NotesApi.Client, {
          ...api,
          Notes: (...args) => {
            if (endpoint === "entity") return Effect.interrupt;

            return api.Notes(...args);
          },
          NoteStats: () => Effect.interrupt,
          NotebookChanges: {
            ...api.NotebookChanges,
            events: (...args) => {
              if (endpoint === "feed") return Stream.fromEffect(Effect.interrupt);

              return api.NotebookChanges.events(...args);
            },
          },
        }),
      });
      const collection = Option.match(
        Option.liftPredicate(endpoint, (name) => name === "standalone"),
        {
          onSome: () => observe(db, stats({ account: ada.account }), cleanup),
          onNone: () => observe(db, notes.list({ account: ada.account }), cleanup),
        },
      );

      await until(() => collection.status === "error", "interrupted endpoint reported");
      expect(collection.health.error?.cause).toBeInstanceOf(HighAlch.Defect);
      expect(connectionOf(db).subsets.size).toBe(0);
      expect(connectionOf(db).feeds.size).toBe(0);
    },
  );

  it("f(nothing, stats) → one row under the key result", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);
    const summary = observe(db, stats({ account: "acc-1" }), cleanup);

    await ready(summary);

    expect(summary.get("result")).toMatchObject({ count: 2 });
  });
});

describe("f(server client, dehydrate) → f(browser client, hydrate)", () => {
  it("shows the server's rows under the same ids before its own load, then follows its feed", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const rendering = account(server, "acc-1", cleanup, { live: false });
    const page = observe<Note>(rendering, notes.list({ account: "acc-1" }), cleanup);

    await ready(page);

    const state = rendering.dehydrate();

    expect(state.collections.map((chunk) => chunk.collectionId)).toContain(
      notes.list({ account: "acc-1" }).id,
    );

    const release = server.hold();
    const browser = account(server, "acc-1", cleanup);

    browser.hydrate(state);

    const list = observe<Note>(browser, notes.list({ account: "acc-1" }), cleanup);

    expect(titles(list)).toEqual(["n1:Ada", "n2:Bob"]);

    release();
    await ready(list);
    await server.send((client) =>
      client.RenameNote(address("acc-1", "n2"), { NoteId: "n2", title: "Bob 2" }),
    );
    await until(() => list.get("n2")?.title === "Bob 2", "feed after hydrate");
  });
});

describe("f(ready subsets, change outside the feed)", () => {
  it("f(list and one loaded, store changed by another write path, reload) → both show the stored row, never without it", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);
    const list = observe<Note>(db, notes.list({ account: "acc-1" }), cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);

    await ready(list, one);

    const seen = history(list, "n1", (note) => note.title);
    const stored = server.store.notes.get("n1");

    if (!stored) throw new Error("n1 was not stored");

    // A write the feed does not carry: nothing changes until the entity reloads.
    server.store.notes.set("n1", { ...stored, title: "Ada (imported)" });
    await tick();

    expect(titles(list)).toEqual(["n1:Ada", "n2:Bob"]);

    HighAlch.reload(db, NoteRows);
    HighAlch.reload(db, NoteRows);
    await until(() => one.get("n1")?.title === "Ada (imported)", "reload");
    await until(() => list.get("n1")?.title === "Ada (imported)", "list reload");

    expect(titles(list)).toEqual(["n1:Ada (imported)", "n2:Bob"]);
    expect(seen).toEqual(["Ada (imported)"]);
    // Two calls within the reload delay asked the query once more, not twice.
    expect(server.store.asked.filter((name) => name === "Notes")).toHaveLength(2);
  });

  it("f(non-live subsets, two explicit reloads) → each re-asks once without opening a feed", async () => {
    const server = await open();
    await seed(server, ada);
    const clock = await manualClock();
    const db = account(server, ada.account, cleanup, { clock, live: false });
    const { list, one, book } = subsets(db);
    await ready(list, one, book);

    await server.send((client) =>
      client.RenameNote(address(ada.account, ada.NoteId), { NoteId: ada.NoteId, title: "Abel" }),
    );
    await server.indexed((stored) => stored.get(ada.NoteId)?.title === "Abel");
    await Effect.runPromise(clock.adjust(1_000));
    expect(titles(list)).toEqual(["n1:Ada"]);
    expect(titles(one)).toEqual(["n1:Ada"]);
    const asked = server.store.asked.length;

    HighAlch.reload(db, NoteRows);
    HighAlch.reload(db, NoteRows);
    await Effect.runPromise(clock.adjust(9));
    expect(server.store.asked).toHaveLength(asked);
    await Effect.runPromise(clock.adjust(1));
    await until(
      () => list.get(ada.NoteId)?.title === "Abel" && one.get(ada.NoteId)?.title === "Abel",
      "non-live subsets reloaded",
    );
    expect(server.store.asked.slice(asked).sort()).toEqual(
      ["NotesByBook", "NoteById", "Notes"].sort(),
    );
    expect(server.wire.counts).toMatchObject({ connections: 0, peeks: 0 });
  });
});

describe("f(client, close)", () => {
  it.each(["during cleanup", "after close"])(
    "f(command called %s) → rolls back immediately, without sending",
    async (when) => {
      const server = await open();
      await seed(server, ada);
      const clock = await manualClock();
      const db = account(server, ada.account, cleanup, { clock });
      const one = observe(db, notes.get({ NoteId: ada.NoteId }), cleanup);
      await ready(one);
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const dispose = db.cleanup.bind(db);
      let disposals = 0;
      db.cleanup = async () => {
        disposals += 1;
        started.resolve();
        await gate.promise;
        await dispose();
      };

      const closed = Effect.runPromise(HighAlch.close(db));
      try {
        await started.promise;
        if (when === "after close") {
          gate.resolve();
          await closed;
        }
        const tx = notes.rename.with({ client: db })({ NoteId: ada.NoteId, title: "Abel" });
        const failure = tx.when("settled").catch((error: unknown) => error);
        await Effect.runPromise(clock.adjust(0));
        expect(tx.state).toBe("failed");
        expect(await failure).toEqual(
          expect.objectContaining({ message: expect.stringMatching(/HighAlch.*clos/i) }),
        );
        if (when === "during cleanup") expect(one.get(ada.NoteId)?.title).toBe("Ada");
        expect(server.wire.counts.commands).toEqual([]);
      } finally {
        gate.resolve();
        await closed;
      }
      await Effect.runPromise(HighAlch.close(db));
      expect(disposals).toBe(1);
    },
  );

  it.each(["explicit close", "layer interruption"])(
    "f(sent rename with no reply, %s) → interrupts at the close deadline and rolls back",
    async (how) => {
      const server = await open();
      await seed(server, ada);
      const clock = await manualClock();
      const api = server.wire.client;
      const sent = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const scoped = Promise.withResolvers<DbClient>();
      const closing = Promise.withResolvers<void>();
      let interrupted = false;
      const config = {
        api: NotesApi,
        layer: Layer.succeed(NotesApi.Client, {
          ...api,
          RenameNote: (target, input, options) =>
            Effect.gen(function* () {
              sent.resolve();
              yield* Effect.promise(() => gate.promise);
              return yield* api.RenameNote(target, input, options);
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ),
        }),
        scope: ada.account,
        clock,
        settleTimeout: 100,
      };
      const user = Effect.runFork(
        Effect.gen(function* () {
          scoped.resolve(yield* HighAlch.Client);
          yield* Effect.never;
        }).pipe(Effect.provide(HighAlch.layer(config))),
      );
      const db = await scoped.promise;
      const one = observe(db, notes.get({ NoteId: ada.NoteId }), cleanup);
      await ready(one);
      const tx = notes.rename.with({ client: db })({ NoteId: ada.NoteId, title: "Abel" });
      const failed = tx.when("settled").catch((error: unknown) => error);
      const seen = history(one, ada.NoteId, (row) => row.title);
      let closed: Promise<void> | undefined;
      try {
        await sent.promise;
        await Effect.runPromise(clock.adjust(1_000));
        expect(tx.state).toBe("persisting");
        expect(one.get(ada.NoteId)?.title).toBe("Abel");

        // Observe when close starts its first wait, before advancing its Clock.
        const dispose = db.cleanup.bind(db);
        let disposals = 0;
        db.cleanup = () => {
          disposals += 1;
          return dispose();
        };
        if (how === "explicit close") closed = Effect.runPromise(HighAlch.close(db));
        else closed = Effect.runPromise(Fiber.interrupt(user));
        void closed.then(() => closing.resolve());
        await tick();
        await Effect.runPromise(clock.adjust(99));
        expect(tx.state).toBe("persisting");
        expect(server.wire.counts.open).toBe(1);

        await Effect.runPromise(clock.adjust(1));
        expect(interrupted).toBe(true);
        await expect(failed).resolves.toEqual(
          expect.objectContaining({
            message: expect.stringMatching(/HighAlch.*closed before the server replied/i),
          }),
        );
        await closing.promise;
        expect(seen).toContain("Ada");
        expect(server.wire.counts.commands).toEqual([]);
        expect(server.wire.counts.open).toBe(0);
        await Effect.runPromise(Fiber.interrupt(user));
        expect(disposals).toBe(1);
      } finally {
        // Let the unfixed implementation drain so a failed assertion can report cleanly.
        gate.resolve();
        await Effect.runPromise(Fiber.interrupt(user));
        await closed;
      }
    },
  );

  it("f(uninterruptible reply, close deadline) → rolls back and closes before the reply", async () => {
    const server = await open();
    await seed(server, ada);
    const clock = await manualClock();
    const sent = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const replied = Promise.withResolvers<void>();
    const api = server.wire.client;
    const db = account(server, ada.account, cleanup, {
      clock,
      settleTimeout: 100,
      layer: Layer.succeed(NotesApi.Client, {
        ...api,
        RenameNote: () =>
          Effect.gen(function* () {
            sent.resolve();
            yield* Effect.promise(() => gate.promise);
            replied.resolve();
            return { reply: undefined, stream: "late", version: 1 };
          }).pipe(Effect.uninterruptible),
      }),
    });
    const one = observe(db, notes.get({ NoteId: ada.NoteId }), cleanup);
    await ready(one);
    const committed = vi.fn();
    const tx = notes.rename.with({ client: db })(
      { NoteId: ada.NoteId, title: "Abel" },
      { onCommitted: committed },
    );
    const failed = tx.when("settled").catch((error: unknown) => error);
    await sent.promise;
    const seen = history(one, ada.NoteId, (row) => row.title);
    const closed = Effect.runPromise(HighAlch.close(db));

    try {
      await Effect.runPromise(clock.adjust(99));
      expect(tx.state).toBe("persisting");
      expect(titles(one)).toEqual(["n1:Abel"]);
      await Effect.runPromise(clock.adjust(1));
      expect(tx.state).toBe("failed");
      await expect(failed).resolves.toMatchObject({
        message: expect.stringMatching(/HighAlch.*closed before the server replied/i),
      });
      await closed;
      expect(tx.state).toBe("failed");
      expect(seen).toContain("Ada");
      expect(server.wire.counts.open).toBe(0);
      const beforeReply = [...seen];
      const peeks = server.wire.counts.peeks;

      gate.resolve();
      await replied.promise;
      await Effect.runPromise(clock.adjust(0));
      expect(tx.state).toBe("failed");
      expect(seen).toEqual(beforeReply);
      expect(server.wire.counts.peeks).toBe(peeks);
      expect(committed).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await closed;
    }
  });

  it.each(["during cleanup", "after close"] as const)(
    "f(client %s, observe new collections) → an immediate defect and no registrations",
    async (when) => {
      const server = await open();
      const db = account(server, ada.account, cleanup);
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const dispose = db.cleanup.bind(db);
      db.cleanup = async () => {
        started.resolve();
        await gate.promise;
        await dispose();
      };
      const closed = Effect.runPromise(HighAlch.close(db));

      try {
        await started.promise;
        if (when === "after close") {
          gate.resolve();
          await closed;
        }
        const list = observe(db, notes.list({ account: ada.account }), cleanup);
        const summary = observe(db, stats({ account: ada.account }), cleanup);
        expect([list.status, summary.status]).toEqual(["error", "error"]);

        const live = createLiveQueryCollection({ query: (q) => q.from({ note: list }) });
        cleanup.push(() => live.cleanup());
        live.startSyncImmediate();
        expect(live.status).toBe("error");
        // A read from a closed client is a bug in the caller: `match` throws it as a defect.
        const thrown = (() => {
          try {
            HighAlch.match({
              data: undefined as ReadonlyArray<Note> | undefined,
              status: live.status,
              isEnabled: true,
              isReady: live.isReady(),
              isLoadingError: live.status === "error",
              isCrashed: live.status === "crashed",
              health: live.health,
              collection: live,
            }).on({ orElse: (state) => state._tag });
          } catch (error) {
            return error;
          }
        })();

        expect(thrown).toBeInstanceOf(HighAlch.Defect);
        expect(String(Cause.squash((thrown as HighAlch.Defect).cause))).toContain(
          "HighAlch client is closing or closed",
        );
        expect(connectionOf(db).subsets.size).toBe(0);
        expect(connectionOf(db).feeds.size).toBe(0);
        expect(server.wire.counts.connections).toBe(0);
        expect(server.store.asked).toEqual([]);
      } finally {
        gate.resolve();
        await closed;
      }
    },
  );

  it("f(ready single row with no row, reloaded while the client closes) → match throws the defect, not Missing", async () => {
    const server = await open();
    const db = account(server, ada.account, cleanup);
    const one = observe(db, notes.get({ NoteId: "absent" }), cleanup);

    await until(() => one.isReady(), "ready with no row");

    const live = createLiveQueryCollection({
      query: (q) => q.from({ note: one }).findOne(),
    });

    cleanup.push(() => live.cleanup());
    live.startSyncImmediate();
    await until(() => live.isReady(), "live ready");

    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const dispose = db.cleanup.bind(db);

    db.cleanup = async () => {
      started.resolve();
      await gate.promise;
      await dispose();
    };

    const closed = Effect.runPromise(HighAlch.close(db));

    try {
      await started.promise;
      await one.reload().catch(() => {});

      const read = () =>
        HighAlch.match({
          data: undefined as Note | undefined,
          status: live.status,
          isEnabled: true,
          isReady: live.isReady(),
          isLoadingError: false,
          isCrashed: false,
          health: live.health,
          collection: live,
        }).on({ orElse: (state) => state._tag });

      expect(read).toThrow(HighAlch.Defect);
    } finally {
      gate.resolve();
      await closed;
    }
  });

  it.each(["last subset cleanup", "client close"] as const)(
    "f(live feed with a held finalizer, %s) → waits for the finalizer",
    async (action) => {
      const server = await open();
      await seed(server, ada);
      const gate = Promise.withResolvers<void>();
      const finishing = Promise.withResolvers<void>();
      const api = server.wire.client;
      let released = false;
      const db = account(server, ada.account, cleanup, {
        layer: Layer.succeed(NotesApi.Client, {
          ...api,
          NotebookChanges: {
            ...api.NotebookChanges,
            events: (...args) =>
              api.NotebookChanges.events(...args).pipe(
                Stream.ensuring(
                  Effect.promise(() => {
                    finishing.resolve();
                    return gate.promise;
                  }).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        released = true;
                      }),
                    ),
                  ),
                ),
              ),
          },
        }),
      });
      const list = observe(db, notes.list({ account: ada.account }), cleanup);
      await ready(list);
      const settled = vi.fn();
      const closing = (
        action === "client close" ? Effect.runPromise(HighAlch.close(db)) : list.cleanup()
      ).then(settled);

      try {
        await finishing.promise;
        // Let the collection cleanup's promise continuations run while the finalizer is held.
        await Effect.runPromise(Effect.yieldNow);
        expect(settled).not.toHaveBeenCalled();
        expect(released).toBe(false);
      } finally {
        gate.resolve();
        await closing;
      }
      expect(released).toBe(true);
      expect(settled).toHaveBeenCalledOnce();
      expect(connectionOf(db).feeds.size).toBe(0);
    },
  );

  it("f(optimistic rename waiting on a debounce, close) → rolls back before the debounce", async () => {
    const server = await open();
    await seed(server, ada);
    const clock = await manualClock();
    const db = account(server, ada.account, cleanup, { clock });
    const one = observe(db, notes.get({ NoteId: ada.NoteId }), cleanup);
    const release = HighAlch.activate(db);
    cleanup.push(async () => release());
    await ready(one);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const rename = createPacedMutations({
        ...notes.rename.paced,
        strategy: debounceStrategy({ wait: 500 }),
      });
      const tx = rename({ NoteId: ada.NoteId, title: "Abel" });
      const failed = tx.when("settled").catch((error: unknown) => error);
      const seen = history(one, ada.NoteId, (row) => row.title);
      expect(tx.state).toBe("pending");
      expect(titles(one)).toEqual(["n1:Abel"]);

      const closing = Effect.runPromise(HighAlch.close(db));
      expect(tx.state).toBe("failed");
      expect(seen).toContain("Ada");
      await expect(failed).resolves.toMatchObject({
        message: "HighAlch client is closing or closed",
      });
      await closing;
      vi.advanceTimersByTime(500);
      expect(server.wire.counts.commands).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("f(two optimistic renames waiting on a debounce, a subscriber throws on the first rollback, close) → both roll back and close completes", async () => {
    const server = await open();
    await seed(server, ada, bob);
    const clock = await manualClock();
    const db = account(server, ada.account, cleanup, { clock });
    const list = observe(db, notes.list({ account: ada.account }), cleanup);
    const release = HighAlch.activate(db);
    cleanup.push(async () => release());
    await ready(list);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const paced = () =>
        createPacedMutations({ ...notes.rename.paced, strategy: debounceStrategy({ wait: 500 }) });
      const first = paced()({ NoteId: ada.NoteId, title: "Abel" });
      const second = paced()({ NoteId: bob.NoteId, title: "Bert" });

      first.when("settled").catch(() => {});
      second.when("settled").catch(() => {});
      expect(titles(list)).toEqual(["n1:Abel", "n2:Bert"]);

      let threw = false;
      const subscription = list.subscribeChanges(() => {
        if (threw) return;

        threw = true;
        throw new Error("a subscriber that throws");
      });
      cleanup.push(async () => subscription.unsubscribe());

      await Effect.runPromise(HighAlch.close(db));

      expect(threw).toBe(true);
      expect([first.state, second.state]).toEqual(["failed", "failed"]);
      vi.advanceTimersByTime(500);
      expect(server.wire.counts.commands).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("f(scoped client, user fails) → closes its feed and owned runtime once", async () => {
    const server = await open();
    await seed(server, ada);
    const api = server.wire.client;
    const disposed = vi.fn();
    const layer = Layer.effect(
      NotesApi.Client,
      Effect.acquireRelease(Effect.succeed(api), () => Effect.sync(disposed)),
    );
    const run = (closeFirst: boolean) =>
      Effect.gen(function* () {
        const db = yield* HighAlch.Client;
        const one = observe(db, notes.get({ NoteId: ada.NoteId }), cleanup);
        yield* Effect.promise(() => ready(one));
        expect(server.wire.counts.open).toBe(1);
        if (closeFirst) yield* HighAlch.close(db);

        return yield* Effect.fail("user failed");
      }).pipe(
        Effect.provide(HighAlch.layer({ api: NotesApi, layer, scope: ada.account })),
        Effect.flip,
      );

    expect(await Effect.runPromise(run(false))).toBe("user failed");
    expect(disposed).toHaveBeenCalledOnce();
    expect(server.wire.counts.open).toBe(0);
    expect(await Effect.runPromise(run(true))).toBe("user failed");
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(server.wire.counts.open).toBe(0);
  });

  it("f(reply received, confirmation peek ignores interruption) → times out and closes", async () => {
    const server = await open();
    await seed(server, ada);
    const clock = await manualClock();
    const api = server.wire.client;
    const peeking = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const committed = vi.fn();
    const db = account(server, ada.account, cleanup, {
      clock,
      settleTimeout: 100,
      layer: Layer.succeed(NotesApi.Client, {
        ...api,
        NotebookChanges: {
          ...api.NotebookChanges,
          peek: (key, options) => {
            if (!options?.atLeast) return api.NotebookChanges.peek(key, options);

            return Effect.promise(() => {
              peeking.resolve();
              return gate.promise;
            }).pipe(Effect.andThen(api.NotebookChanges.peek(key, options)), Effect.uninterruptible);
          },
        },
      }),
    });
    const list = observe(db, notes.list({ account: ada.account }), cleanup);
    await ready(list);
    server.wire.mute(true);
    const tx = notes.rename.with({ client: db })(
      { NoteId: ada.NoteId, title: "Abel" },
      { onCommitted: committed },
    );
    await peeking.promise;
    const closing = Effect.runPromise(HighAlch.close(db));

    try {
      await Effect.runPromise(clock.adjust(100));
      expect(tx.state).toBe("completed");
      await closing;
      expect(committed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ _tag: "Unconfirmed" }),
      );
      expect(server.wire.counts.open).toBe(0);
    } finally {
      gate.resolve();
      await closing;
    }
  });

  it("f(reply just before the close deadline, feed silent) → gets the full confirmation timeout", async () => {
    const server = await open();
    await seed(server, ada);
    const clock = await manualClock();
    const api = server.wire.client;
    const sent = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    const replied = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<HighAlch.Settled<unknown>>();
    const db = account(server, ada.account, cleanup, {
      clock,
      settleTimeout: 100,
      layer: Layer.succeed(NotesApi.Client, {
        ...api,
        RenameNote: (target, input, options) =>
          api.RenameNote(target, input, options).pipe(
            Effect.tap(() =>
              Effect.promise(() => {
                sent.resolve();
                return reply.promise;
              }),
            ),
            Effect.tap(() => Effect.sync(() => replied.resolve())),
          ),
      }),
    });
    const one = observe(db, notes.get({ NoteId: ada.NoteId }), cleanup);
    await ready(one);
    server.wire.mute(true);
    const tx = notes.rename.with({ client: db })(
      { NoteId: ada.NoteId, title: "Abel" },
      { onCommitted: settled.resolve },
    );
    await sent.promise;
    const close = Effect.runPromise(HighAlch.close(db));

    try {
      await Effect.runPromise(clock.adjust(99));
      reply.resolve();
      await replied.promise;
      await tick();
      await Effect.runPromise(clock.adjust(99));
      expect(tx.state).toBe("persisting");
      expect(one.get(ada.NoteId)?.title).toBe("Abel");
      expect(server.wire.counts.open).toBe(1);
      await Effect.runPromise(clock.adjust(1));
      await close;
      expect(await settled.promise).toMatchObject({ _tag: "Unconfirmed" });
      expect(server.wire.counts.open).toBe(0);
    } finally {
      reply.resolve();
      await Effect.runPromise(clock.adjust(1_000));
      await close;
    }
  });

  it("f(rename sent, feed silent, close) → close waits until the rename settled (here Unconfirmed); the row showed it until then", async () => {
    const server = await open();

    await seed(server, ada);

    const db = HighAlch.make({
      api: NotesApi,
      layer: Layer.succeed(NotesApi.Client, server.wire.client),
      scope: "acc-1",
      settleTimeout: 150,
    });

    const one = db.collection(notes.get({ NoteId: "n1" }));
    const subscription = one.subscribeChanges(() => {}, { includeInitialState: true });

    await ready(one);
    server.wire.mute(true);

    const order: Array<string> = [];
    const renamed = notes.rename.with({ client: db })({ NoteId: "n1", title: "Ada 2" });

    void renamed.when("settled").then(() => order.push("settled"));

    const closed = Effect.runPromise(HighAlch.close(db)).then(() => order.push("closed"));

    await tick();

    expect(order).toEqual([]);
    expect(one.get("n1")?.title).toBe("Ada 2");

    await closed;
    subscription.unsubscribe();
    server.wire.mute(false);

    expect(order).toEqual(["settled", "closed"]);
  });
});
