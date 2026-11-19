import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createOptimisticAction,
  createPacedMutations,
  debounceStrategy,
  DbClient,
} from "@tanstack/db";
import { Effect, Layer, Option, Predicate } from "effect";
import * as HighAlch from "@highalch/db";
import { account, observe, seed, tick, titles, until, type Host } from "../../../fixtures/harness";
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

    const release = server.hold();
    const db = account(server, "acc-1", cleanup);
    const list = observe<Note>(db, notes.list({ account: "acc-1" }), cleanup);

    // The query answered from the store as it was; these writes land after the snapshot cursor.
    await until(() => server.store.asked.includes("Notes"), "query asked");
    await server.send((client) =>
      client.RenameNote(address("acc-1", "n1"), { NoteId: "n1", title: "Ada 2" }),
    );
    await server.send((client) => client.DeleteNote(address("acc-1", "n2"), { NoteId: "n2" }));
    await server.send((client) =>
      client.CreateNote(address("acc-1", "n3"), { account: "acc-1", BookId: "b1", title: "Cyd" }),
    );
    await tick();

    expect(list.isReady()).toBe(false);

    release();
    await ready(list);
    await until(() => titles(list).length === 2, "reload for n3");

    expect(titles(list)).toEqual(["n1:Ada 2", "n3:Cyd"]);
    expect(list.size).toBe(2);
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

  it("f(unknown row, membership rule) → inserted where the rule holds; without a rule → one debounced reload", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);
    const { list, book } = subsets(db);
    const later = observe<Note>(db, notes.get({ NoteId: "n3" }), cleanup);

    await ready(list, book, later);

    const asked = { ...countAsked(server) };

    await server.send((client) =>
      client.CreateNote(address("acc-1", "n3"), { account: "acc-1", BookId: "b1", title: "Cyd" }),
    );
    await until(() => book.has("n3") && later.has("n3") && list.has("n3"), "n3 everywhere");
    await tick(50);

    expect(countAsked(server).NotesByBook).toBe(asked.NotesByBook);
    expect(countAsked(server).NoteById).toBe(asked.NoteById);
    expect(countAsked(server).Notes).toBe(asked.Notes + 1);

    // A rule that stops holding takes the row out of that subset only.
    await server.send((client) =>
      client.MoveNote(address("acc-1", "n1"), { NoteId: "n1", BookId: "b2" }),
    );
    await until(() => !book.has("n1"), "moved out of b1");

    expect(list.get("n1")?.BookId).toBe("b2");
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
    NoteStats: count("NoteStats"),
  };
};

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

    // Optimistic at once under a fresh client-generated key: in the list (no rule), not in
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
      queries: { list: Notes },
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
      queries: { list: Notes },
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
  it("f(ready, feed cut) → reportError (failureReason), then recovery from the last seq", async () => {
    const server = await open();

    await seed(server, ada);

    const retry: HighAlch.Retry = (error, attempt) =>
      attempt <= 3 && Predicate.isTagged(error, "RpcClientError") ? Option.some(60) : Option.none();

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
});

describe("f(client, close)", () => {
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

    const closed = HighAlch.close(db).then(() => order.push("closed"));

    await tick();

    expect(order).toEqual([]);
    expect(one.get("n1")?.title).toBe("Ada 2");

    await closed;
    subscription.unsubscribe();
    server.wire.mute(false);

    expect(order).toEqual(["settled", "closed"]);
  });
});
