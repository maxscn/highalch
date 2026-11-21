import { createOptimisticAction, createPacedMutations, debounceStrategy } from "@tanstack/db";
import { Effect, Option } from "effect";
import { Story as Alchemy } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "vite-plus/test";
import * as LowAlch from "@lowalch/tanstack-db";
import * as Story from "@highalch/story";
import { Db } from "@highalch/story/tanstack-db";
import {
  entries,
  entryStore,
  EntryEmpty,
  EntryStore,
  ledger,
  LedgerApi,
  session,
} from "../../../fixtures/ledger";
import {
  address,
  CreateNote,
  DeleteNote,
  NoteAggregate,
  NoteChanged,
  NoteCreated,
  NoteLocked,
  NoteRows,
  NotesApi,
  NoteStore,
  NotesByCursor,
  QueryRefused,
  RenameNote,
  WrappedNotes,
  notebook,
  store,
  type Client,
  type Note,
} from "../../../fixtures/notebook";
import { notes, stats } from "../../../fixtures/notes";

/**
 * The package's transitions as stories: the Notebook model hosted in memory, a real `LowAlch`
 * client per account behind the story's wire, on the story's manual clock.
 */
const story = Story.make(Story.memory({ api: NotesApi, layer: notebook, services: store }), {
  scope: "acc-1",
});

const ada: Note = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada", pinned: false };

const bob: Note = { NoteId: "n2", account: "acc-1", BookId: "b2", title: "Bob", pinned: false };

const eve: Note = { NoteId: "e1", account: "acc-2", BookId: "b1", title: "Eve", pinned: false };

const refOf = (note: Note) => NoteAggregate.ref(address(note.account, note.NoteId));

/** History: the notes exist (seeded as committed events, as alchemy's `Story.given` seeds). */
const exist = (...seeded: ReadonlyArray<Note>) =>
  seeded.map((note) => Story.given(refOf(note), new NoteCreated({ note })));

const list = notes.list({ account: "acc-1" });

const one = notes.get({ NoteId: "n1" });

const book = notes.byBook({ BookId: "b1" });

describe("f(read declarations, feed burst) as stories", () => {
  it("places rows by rule and re-asks each query-decided subset once", async () => {
    const reads = LowAlch.collection(NoteRows, {
      queries: {
        read: LowAlch.read(NotesByCursor),
        bare: NotesByCursor,
        wrapped: LowAlch.read(WrappedNotes)
          .rows((answer) => answer.Items)
          .where((row, input) => row.account === input.account),
      },
    });

    const input = { account: "acc-1" };
    const explicit = reads.read(input, { take: 10 });
    const bare = reads.bare(input, { take: 20 });
    const selected = notes.page({ ...input, Offset: 0, Limit: 10 });
    const wrapped = reads.wrapped({ ...input, Offset: 0, Limit: 10 });
    const single = notes.get({ NoteId: "n3" });
    const queryDecided = [explicit, bare, selected];
    const allSources = [list, single, book, wrapped, ...queryDecided];
    const cyd: Note = { ...ada, NoteId: "n3", title: "Cyd" };
    const initial = [{ title: "Ada" }, { title: "Bob" }];
    const patched = [{ title: "Ada 2" }, { title: "Bob" }];
    const added = [...patched, { title: "Cyd" }];

    await story.with({ invariants: Db.invariants })(
      exist(ada, bob),
      allSources.map((source) => Db.open(source)),
      Db.then(list, initial),
      Db.then(single, []),
      Db.then(book, [{ title: "Ada" }]),
      Db.then(wrapped, initial),
      queryDecided.map((source) => Db.then(source, initial)),
      Story.check("each subset loads once", (world) => {
        expect(world.wire().asked.toSorted()).toEqual([
          "NoteById",
          "Notes",
          "NotesByBook",
          "NotesByCursor",
          "NotesByCursor",
          "NotesByTitle",
          "WrappedNotes",
        ]);
      }),
      Story.remote(refOf(ada), new RenameNote({ NoteId: "n1", title: "Ada 2" })),
      Story.remote(refOf(cyd), new CreateNote({ ...input, BookId: cyd.BookId, title: cyd.title })),
      Db.then(list, added),
      Db.then(single, [{ title: "Cyd" }]),
      Db.then(book, [{ title: "Ada 2" }, { title: "Cyd" }]),
      Db.then(wrapped, added),
      queryDecided.map((source) => Db.then(source, patched)),
      Story.check("feed patches arrive before another query is sent", (world) => {
        expect(world.wire().asked).toHaveLength(allSources.length);
      }),
      Story.advance(10),
      queryDecided.map((source) => Db.then(source, added)),
      Story.advance(10),
      Story.check(
        "each query-decided subset re-asks once and rule-based subsets send no query",
        (world) => {
          expect(world.wire().asked.slice(allSources.length).toSorted()).toEqual([
            "NotesByCursor",
            "NotesByCursor",
            "NotesByTitle",
          ]);
        },
      ),
    );
  });
});

describe("f(ready subsets, command) as stories", () => {
  it("f(ready, rename) → optimistic at once, then committed in every subset; never back", async () => {
    await story.with({ invariants: Db.invariants })(
      exist(ada, bob),
      Db.then(list, [{ title: "Ada" }, { title: "Bob" }]),
      Db.then(one, [{ title: "Ada" }]),
      Db.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Db.then(list, [{ title: "Ada 2", $hasPendingWrites: true }, { title: "Bob" }]),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: true }]),
      Db.settled("Committed"),
      Db.then(list, [{ title: "Ada 2", $hasPendingWrites: false }, { title: "Bob" }]),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: false }]),
    );
  });

  it("f(ready, rejected rename) → rolled back with the original NoteLocked", async () => {
    await story.with({ invariants: Db.invariants })(
      exist(ada),
      Db.then(one, [{ title: "Ada" }]),
      Db.when(notes.rename, { NoteId: "n1", title: "locked" }),
      Db.then(one, [{ title: "locked", $hasPendingWrites: true }]),
      Db.rejected(new NoteLocked({ title: "locked" })),
      Db.then(one, [{ title: "Ada", $hasPendingWrites: false }]),
    );
  });

  it("f(insert, update, edit, delete) → each optimistic where its rule holds, then committed", async () => {
    await story.with({ invariants: Db.invariants })(
      exist(ada, bob),
      Db.open(list),
      Db.open(book),
      Db.when(notes.file, { account: "acc-1", BookId: "b2", title: "Cyd" }),
      // In the list (no rule), not in book b1 (its rule refuses b2).
      Db.then(list, (rows) => rows.some((row) => row.NoteId === "b2:Cyd" && row.$hasPendingWrites)),
      Db.then(book, [{ NoteId: "n1" }]),
      Db.settled("Committed"),
      Db.when(notes.pin, { NoteId: "n1", pinned: true }),
      Db.then(book, [{ NoteId: "n1", pinned: true, $hasPendingWrites: true }]),
      Db.settled("Committed"),
      Db.when(notes.remove, { NoteId: "n2" }),
      Db.then(list, [{ NoteId: "b2:Cyd" }, { NoteId: "n1", pinned: true }]),
      Db.settled("Committed"),
      Db.then(list, [{ NoteId: "b2:Cyd", $hasPendingWrites: false }, { NoteId: "n1" }]),
    );
  });

  it("f(.options and .paced) → the same steps run createOptimisticAction and paced mutations", async () => {
    await story.with({ invariants: Db.invariants })(
      exist(ada),
      Db.open(one),
      Db.when("pin through createOptimisticAction", ({ activate }) => {
        activate();

        return createOptimisticAction(notes.pin.options)({ NoteId: "n1", pinned: true });
      }),
      Db.then(one, [{ pinned: true, $hasPendingWrites: true }]),
      Db.settled(),
      Db.when("three paced renames", () => {
        const mutate = createPacedMutations({
          ...notes.rename.paced,
          strategy: debounceStrategy({ wait: 1 }),
        });

        const calls = ["A", "Ad", "Ada 3"].map((title) => mutate({ NoteId: "n1", title }));

        return calls[0] ?? mutate({ NoteId: "n1", title: "Ada 3" });
      }),
      Db.then(one, [{ title: "Ada 3", pinned: true, $hasPendingWrites: true }]),
      Db.settled(),
      Db.then(one, [{ title: "Ada 3", pinned: true, $hasPendingWrites: false }]),
      Story.check("one RenameNote sent for three paced calls", (world) => {
        const sent = world.wire().sent.filter((each) => each.name === "RenameNote");

        expect(sent).toHaveLength(1);
      }),
    );
  });

  it("f(feed silent, rename) → Unconfirmed once the settle timeout passes; the subset reloads", async () => {
    await story(
      exist(ada),
      Db.open(one),
      Story.mute(),
      Db.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Story.advance(2_000),
      Db.settled("Unconfirmed"),
      Story.advance(10),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: false }]),
    );
  });
});

describe("f(subsets, load) as stories", () => {
  it("f(load in flight, writes race the query) → every write applied once, nothing missed", async () => {
    await story.with({ invariants: Db.invariants })(
      exist(ada, bob),
      Story.hold(),
      Db.open(list),
      Db.then(list, { state: "Loading" }),
      // The query answered from the store as it was; these writes land after its cursor.
      Story.remote(refOf(ada), new RenameNote({ NoteId: "n1", title: "Ada 2" })),
      Story.remote(refOf(bob), new DeleteNote({ NoteId: "n2" })),
      Story.remote(
        NoteAggregate.ref(address("acc-1", "n3")),
        new CreateNote({ account: "acc-1", BookId: "b1", title: "Cyd" }),
      ),
      Db.then(list, { state: "Loading" }),
      Story.release(),
      Db.then(list, { state: "Ready" }),
      // n3 has no rule to place it in the list: the list reloads after its debounce.
      Story.advance(10),
      Db.then(list, [
        { NoteId: "n1", title: "Ada 2" },
        { NoteId: "n3", title: "Cyd" },
      ]),
    );
  });

  it("f(typed query failure, recover, retry) → the error state, then Ready", async () => {
    await story(
      exist(ada),
      Story.fail("NotesByBook", new QueryRefused()),
      Db.open(book),
      Db.then(book, { state: new QueryRefused() }),
      Story.recover("NotesByBook"),
      Db.reload(book),
      Db.then(book, { state: "Ready" }),
      Db.then(book, [{ NoteId: "n1" }]),
    );
  });
});

describe("f(ready subsets, another client's change) as stories", () => {
  it("f(three subsets, server rename then delete) → every subset that shows the row follows", async () => {
    await story.with({ invariants: Db.invariants })(
      exist(ada, bob),
      Db.open(list),
      Db.open(one),
      Db.open(book),
      Story.remote(refOf(ada), new RenameNote({ NoteId: "n1", title: "Ada 2" })),
      Db.then(list, [{ title: "Ada 2" }, { title: "Bob" }]),
      Db.then(one, [{ title: "Ada 2" }]),
      Db.then(book, [{ title: "Ada 2" }]),
      Story.given(refOf(ada), new NoteChanged({ note: { ...ada, title: "Ada 3" } })),
      Db.then(one, [{ title: "Ada 3" }]),
      Story.remote(refOf(ada), new DeleteNote({ NoteId: "n1" })),
      Db.then(list, [{ title: "Bob" }]),
      Db.then(one, []),
      Db.then(book, []),
    );
  });

  it("f(ready, feed drops; a write meanwhile; feed resumes) → Retrying, then the write, from the last seq", async () => {
    let asked = 0;

    await story.with({ invariants: Db.invariants })(
      exist(ada),
      Db.then(book, [{ NoteId: "n1" }]),
      Story.check("count the queries", (world) => {
        asked = world.wire().asked.length;
      }),
      Story.drop(),
      Db.then(book, { state: "Retrying", fields: { attempt: 2 } }),
      Story.remote(
        NoteAggregate.ref(address("acc-1", "n4")),
        new CreateNote({ account: "acc-1", BookId: "b1", title: "Dee" }),
      ),
      Db.then(book, [{ NoteId: "n1" }]),
      Story.resume(),
      Db.then(book, { state: "Ready" }),
      Db.then(book, [{ NoteId: "n1" }, { NoteId: "n4", title: "Dee" }]),
      Story.check("resumed from its last seq: no reload, the rule placed n4", (world) => {
        expect(world.wire().asked).toHaveLength(asked);
      }),
    );
  });

  it("f(two accounts, module-level declarations) → each client follows only its own scope", async () => {
    await story.with({ invariants: Db.invariants })(
      exist(ada, eve),
      Db.then(book, [{ NoteId: "e1" }, { NoteId: "n1" }]),
      Story.as("acc-2", Db.then(book, [{ NoteId: "e1" }, { NoteId: "n1" }])),
      Db.when(notes.rename, { NoteId: "n1", title: "Mine" }),
      Db.settled("Committed"),
      Story.as(
        "acc-2",
        Story.remote("rename e1", (api: Client) =>
          api.RenameNote(address("acc-2", "e1"), { NoteId: "e1", title: "Theirs" }),
        ),
        Db.then(book, [
          { NoteId: "e1", title: "Theirs" },
          { NoteId: "n1", title: "Ada" },
        ]),
      ),
      // Each feed carries only its account's changes.
      Db.then(book, [
        { NoteId: "e1", title: "Eve" },
        { NoteId: "n1", title: "Mine" },
      ]),
    );
  });

  it("f(alchemy's Story.given and Db.when) → history and another client's write on the host", async () => {
    await story.with({ invariants: Db.invariants })(
      Story.alchemy(Alchemy.given(refOf(ada), new NoteCreated({ note: ada }))),
      Db.then(one, [{ title: "Ada" }]),
      Story.alchemy(Alchemy.when(refOf(ada), new RenameNote({ NoteId: "n1", title: "Ada 2" }))),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: false }]),
    );
  });

  it("f(server store, check) → a check reads the host's services", async () => {
    await story(
      exist(ada),
      Db.open(stats({ account: "acc-1" })),
      Db.then(stats({ account: "acc-1" }), [{ count: 1 }]),
      Story.check("the index holds n1", async (world) => {
        const notesStore = await world.host.service?.(NoteStore);

        expect(notesStore?.notes.get("n1")?.title).toBe("Ada");
      }),
    );
  });
});

describe("f(change outside the feed, client close) as stories", () => {
  it("f(list and one shown, store changed by another write path, reload(Rows)) → both show the stored row, never back", async () => {
    await story(
      exist(ada, bob),
      Db.open(list),
      Db.open(one),
      Story.check("another write path changes n1 (the feed does not carry it)", async (world) => {
        const notesStore = await world.host.service?.(NoteStore);
        const stored = notesStore?.notes.get("n1");

        if (stored) notesStore?.notes.set("n1", { ...stored, title: "Ada (imported)" });
      }),
      Story.settle(),
      Db.then(list, [{ title: "Ada" }, { title: "Bob" }]),
      Db.reload(NoteRows),
      Db.then(list, [{ title: "Ada (imported)" }, { title: "Bob" }]),
      Db.then(one, [{ title: "Ada (imported)", $hasPendingWrites: false }]),
      Db.check("each subset showed n1 once more, in one transaction", (db) => {
        for (const observed of db.observed())
          expect(Db.historyOf(observed, "n1", ["title"])).toBe(
            '{"title":"Ada"} → {"title":"Ada (imported)"}',
          );
      }),
    );
  });

  it("f(rename in flight, feed muted, story fails) → the failure is reported; closing still ends", async () => {
    // `LowAlch.close` waits for sent commands: the story lets the reply through and runs its
    // clock's waits (here the settle timeout), so the failure surfaces instead of a hang.
    const failure = await story(
      exist(ada),
      Db.open(one),
      Story.mute(),
      Db.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Db.then(one, [{ title: "Ada" }]),
    ).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure).toBeInstanceOf(Story.StoryFailure);
    expect(failure?.step).toBe(5);
  });
});

const ledgerStory = Story.make(
  Story.memory({ api: LedgerApi, layer: ledger, services: entryStore, session }),
  { scope: "acc-1" },
);

describe("f(deferred settlement, command) as stories", () => {
  const ledgerList = entries.list({ account: "acc-1" });

  const saved = (EntryId: string, text: string) =>
    Story.remote("save as another client", (api: typeof LedgerApi.Client.Service) =>
      api.SaveEntry(JSON.stringify(["acc-1", EntryId]), { value: { text } }),
    );

  it("f(stored later, update) → settled by the row delivered under the command's id (cause)", async () => {
    await ledgerStory.with({ invariants: Db.invariants })(
      saved("e1", "Ada"),
      Db.then(ledgerList, [{ EntryId: "e1", text: "Ada" }]),
      Db.when(entries.save, { value: { EntryId: "e1", text: "Ada 2" } }),
      Db.then(ledgerList, [{ text: "Ada 2", $hasPendingWrites: true }]),
      // On the manual clock the settle timeout never passes: Committed is the feed's delivery.
      Db.settled("Committed"),
      Db.then(ledgerList, [{ text: "Ada 2", $hasPendingWrites: false }]),
      Db.check("the entry names the command as its cause", async (db) => {
        const run = db.runs.at(-1);
        const feed = await db.entries();

        expect(feed.at(-1)?.commandId).toBe(run?.transaction.id);
      }),
    );
  });

  it("f(store refuses, update) → nothing delivered: Unconfirmed after the timeout, reloaded", async () => {
    await ledgerStory(
      saved("e1", "Ada"),
      Db.open(ledgerList),
      Story.check("refuse e1", async (world) => {
        (await world.host.service?.(EntryStore))?.refuse.add("e1");
      }),
      Db.when(entries.save, { value: { EntryId: "e1", text: "Ada 2" } }),
      Story.advance(2_000),
      Db.settled("Unconfirmed"),
      Story.advance(10),
      Db.then(ledgerList, [{ text: "Ada", $hasPendingWrites: false }]),
    );
  });

  it("f(rejected decision, update) → rolls back with EntryEmpty", async () => {
    await ledgerStory.with({ invariants: Db.invariants })(
      saved("e1", "Ada"),
      Db.open(ledgerList),
      Db.when(entries.save, { value: { EntryId: "e1", text: "" } }),
      Db.rejected(new EntryEmpty()),
      Db.then(ledgerList, [{ text: "Ada", $hasPendingWrites: false }]),
    );
  });
});

describe("f(command.result, awaited in a plain function) as stories", () => {
  type Outcome = Awaited<ReturnType<typeof notes.rename.result>>;

  /** A call's promise, kept between the step that makes it and the step that reads it. */
  const held = () => {
    let outcome: Promise<Outcome> | undefined;

    return {
      call: (title: string, bound = true, applied = true) =>
        Db.check(`result of rename to ${title}`, async (clients) => {
          const { db } = await clients.connect();
          const shown = db.collection(one);
          let command = notes.rename;
          let release = () => {};

          // Bound to the story's client, or on the client the provider registered.
          if (bound) command = notes.rename.with({ client: db });
          else release = LowAlch.activate(db);

          try {
            outcome = command.result({ NoteId: "n1", title });

            // In the same frame as the call: the edit is applied before `result` returns.
            if (applied) expect(shown.get("n1")?.title).toBe(title);
          } finally {
            release();
          }

          // Nothing waits here: the next step sees what the call did before it returned.
          outcome.catch(() => {});
        }),
      read: (label: string, check: (outcome: Outcome) => void) =>
        Story.check(label, async () =>
          check(await Option.getOrThrow(Option.fromUndefinedOr(outcome))),
        ),
      rejects: (label: string, message: string) =>
        Story.check(label, async () => {
          await expect(outcome).rejects.toThrow(message);
        }),
    };
  };

  it("f(rename) → the row is pending when result returns; the promise resolves Committed", async () => {
    const rename = held();

    await story.with({ invariants: Db.invariants })(
      exist(ada),
      Db.open(one),
      rename.call("Ada 2"),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: true }]),
      Story.settle(),
      rename.read("resolved Committed", (outcome) => expect(outcome._tag).toBe("Committed")),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: false }]),
    );
  });

  it("f(rename, on the client the provider registered) → the same, with no client passed", async () => {
    const rename = held();

    await story(
      exist(ada),
      Db.open(one),
      rename.call("Ada 2", false),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: true }]),
      Story.settle(),
      rename.read("resolved Committed", (outcome) => expect(outcome._tag).toBe("Committed")),
    );
  });

  it("f(locked rename) → the promise resolves with the typed rejection; the row rolls back", async () => {
    const rename = held();

    await story.with({ invariants: Db.invariants })(
      exist(ada),
      Db.open(one),
      rename.call("locked"),
      Db.then(one, [{ title: "locked", $hasPendingWrites: true }]),
      Story.settle(),
      rename.read("resolved NoteLocked", (outcome) => {
        expect(outcome).toBeInstanceOf(NoteLocked);
        expect(outcome).toMatchObject({ _tag: "NoteLocked", title: "locked" });
      }),
      Db.then(one, [{ title: "Ada", $hasPendingWrites: false }]),
    );
  });

  it("f(rename, feed muted) → the promise resolves Unconfirmed after the settle timeout", async () => {
    const rename = held();

    await story(
      exist(ada),
      Db.open(one),
      Story.mute(),
      rename.call("Ada 2"),
      Story.advance(10_000),
      rename.read("resolved Unconfirmed", (outcome) => expect(outcome._tag).toBe("Unconfirmed")),
    );
  });

  it("f(rename on a closed client) → the promise rejects: a closed client is not a typed outcome", async () => {
    const rename = held();

    await story(
      exist(ada),
      Db.open(one),
      Db.check("close the client", async (clients) => {
        const { db } = await clients.connect();

        await Effect.runPromise(LowAlch.close(db));
      }),
      rename.call("Ada 2", true, false),
      rename.rejects("rejected", "LowAlch client is closing or closed"),
    );
  });

  it("f(result never awaited, with no client registered) → no unhandled rejection", async () => {
    const unhandled: Array<unknown> = [];
    const note = (reason: unknown) => unhandled.push(reason);

    process.on("unhandledRejection", note);

    try {
      void notes.rename.result({ NoteId: "n1", title: "Ada 2" });
      await new Promise((done) => setTimeout(done, 20));
    } finally {
      process.off("unhandledRejection", note);
    }

    expect(unhandled).toEqual([]);
  });

  it("f(rename whose onCommitted throws) → the promise still resolves Committed; no unhandled rejection", async () => {
    const unhandled: Array<unknown> = [];
    const note = (reason: unknown) => unhandled.push(reason);
    let outcome: Promise<Outcome> | undefined;

    process.on("unhandledRejection", note);

    try {
      await story(
        exist(ada),
        Db.open(one),
        Db.check("result of a rename with a throwing reaction", async (clients) => {
          const { db } = await clients.connect();

          outcome = notes.rename
            .with({
              client: db,
              onCommitted: () => {
                throw new Error("a reaction that throws");
              },
            })
            .result({ NoteId: "n1", title: "Ada 2" });
        }),
        Story.settle(),
        Story.check("resolved Committed", async () => {
          expect((await Option.getOrThrow(Option.fromUndefinedOr(outcome)))._tag).toBe("Committed");
        }),
      );
      await new Promise((done) => setTimeout(done, 20));
    } finally {
      process.off("unhandledRejection", note);
    }

    expect(unhandled).toEqual([]);
  });

  it("f(rename with no client registered) → the promise rejects; nothing is thrown at the call", async () => {
    await expect(notes.rename.result({ NoteId: "n1", title: "Ada 2" })).rejects.toThrow(
      "No LowAlch client is active",
    );
  });
});

describe("f(story failure) → a readable report", () => {
  it("names the step, expected vs observed, and each key's history", async () => {
    const failure = await story(
      exist(ada),
      Db.open(one),
      Db.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Db.settled("Committed"),
      Db.then(one, [{ title: "Ada" }]),
    ).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure).toBeInstanceOf(Story.StoryFailure);
    expect(failure?.message).toContain("Step 5 (then");
    expect(failure?.message).toMatch(
      /expected \[\{"title":"Ada"\}\][\s\S]*observed[\s\S]*n1: \{"title":"Ada"\} → \{"title":"Ada 2"\} \(pending\) → \{"title":"Ada 2"\}[\s\S]*✓ 4\. settled Committed[\s\S]*✗ 5\. then/,
    );
  });
});

describe("view helpers", () => {
  it("f(view(source, state)) → match reads each state, with the source's typed errors", () => {
    const data = [ada];
    const retry = () => {};

    const shown = [
      Db.view(list, Db.Live.Loading()),
      Db.view(list, Db.Live.Retrying({ error: new QueryRefused(), attempt: 2, data })),
      Db.view(list, Db.Live.Ready({ data, feed: Option.none(), retry })),
      Db.view(list, Db.Live.Ready({ data, feed: Option.some(new QueryRefused()), retry })),
      Db.view(list, new QueryRefused()),
    ].map((result) =>
      LowAlch.match(result).on({
        Loading: () => "loading",
        Retrying: ({ error, attempt, data }) => `retrying:${error._tag}:${attempt}:${data.length}`,
        Ready: ({ data, feed }) =>
          `ready:${data.map((note) => note.title).join(",")}:${Option.match(feed, {
            onNone: () => "live",
            onSome: (error) => error._tag,
          })}`,
        QueryRefused: (error, { retry }) => {
          retry();

          return `refused:${error instanceof QueryRefused}`;
        },
        RpcClientError: () => "transport",
      }),
    );

    expect(shown).toEqual([
      "loading",
      "retrying:QueryRefused:2:1",
      "ready:Ada:live",
      "ready:Ada:QueryRefused",
      "refused:true",
    ]);
  });

  it("f(Settled, Live) → the constructors of each outcome and state", () => {
    const outcome = (): LowAlch.Settled<undefined> =>
      Db.Settled.Committed({ reply: undefined, stream: "Note/n1", version: 2 });

    const committed = outcome();

    expect(
      LowAlch.match(committed).on({ Committed: () => "saved", Unconfirmed: () => "unconfirmed" }),
    ).toBe("saved");
    expect(Db.Live.Missing()._tag).toBe("Missing");
  });
});
