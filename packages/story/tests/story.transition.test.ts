import { createOptimisticAction, createPacedMutations, debounceStrategy } from "@tanstack/db";
import { Option } from "effect";
import { Story as Alchemy } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "vite-plus/test";
import * as HighAlch from "@highalch/tanstack-db";
import * as Story from "@highalch/story";
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
  QueryRefused,
  RenameNote,
  notebook,
  store,
  type Client,
  type Note,
} from "../../../fixtures/notebook";
import { notes, stats } from "../../../fixtures/notes";

/**
 * The package's transitions as stories: the Notebook model hosted in memory, a real `HighAlch`
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

describe("f(ready subsets, command) as stories", () => {
  it("f(ready, rename) → optimistic at once, then committed in every subset; never back", async () => {
    await story.with({ invariants: Story.invariants })(
      exist(ada, bob),
      Story.shows(list, [{ title: "Ada" }, { title: "Bob" }]),
      Story.shows(one, [{ title: "Ada" }]),
      Story.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Story.shows(list, [{ title: "Ada 2", $hasPendingWrites: true }, { title: "Bob" }]),
      Story.shows(one, [{ title: "Ada 2", $hasPendingWrites: true }]),
      Story.settled("Committed"),
      Story.shows(list, [{ title: "Ada 2", $hasPendingWrites: false }, { title: "Bob" }]),
      Story.shows(one, [{ title: "Ada 2", $hasPendingWrites: false }]),
    );
  });

  it("f(ready, rejected rename) → rolled back with the original NoteLocked", async () => {
    await story.with({ invariants: Story.invariants })(
      exist(ada),
      Story.shows(one, [{ title: "Ada" }]),
      Story.when(notes.rename, { NoteId: "n1", title: "locked" }),
      Story.shows(one, [{ title: "locked", $hasPendingWrites: true }]),
      Story.rejected(new NoteLocked({ title: "locked" })),
      Story.shows(one, [{ title: "Ada", $hasPendingWrites: false }]),
    );
  });

  it("f(insert, update, edit, delete) → each optimistic where its rule holds, then committed", async () => {
    await story.with({ invariants: Story.invariants })(
      exist(ada, bob),
      Story.open(list),
      Story.open(book),
      Story.when(notes.file, { account: "acc-1", BookId: "b2", title: "Cyd" }),
      // In the list (no rule), not in book b1 (its rule refuses b2).
      Story.shows(list, (rows) =>
        rows.some((row) => row.NoteId === "b2:Cyd" && row.$hasPendingWrites),
      ),
      Story.shows(book, [{ NoteId: "n1" }]),
      Story.settled("Committed"),
      Story.when(notes.pin, { NoteId: "n1", pinned: true }),
      Story.shows(book, [{ NoteId: "n1", pinned: true, $hasPendingWrites: true }]),
      Story.settled("Committed"),
      Story.when(notes.remove, { NoteId: "n2" }),
      Story.shows(list, [{ NoteId: "b2:Cyd" }, { NoteId: "n1", pinned: true }]),
      Story.settled("Committed"),
      Story.shows(list, [{ NoteId: "b2:Cyd", $hasPendingWrites: false }, { NoteId: "n1" }]),
    );
  });

  it("f(.options and .paced) → the same steps run createOptimisticAction and paced mutations", async () => {
    await story.with({ invariants: Story.invariants })(
      exist(ada),
      Story.open(one),
      Story.when("pin through createOptimisticAction", ({ activate }) => {
        activate();

        return createOptimisticAction(notes.pin.options)({ NoteId: "n1", pinned: true });
      }),
      Story.shows(one, [{ pinned: true, $hasPendingWrites: true }]),
      Story.settled(),
      Story.when("three paced renames", () => {
        const mutate = createPacedMutations({
          ...notes.rename.paced,
          strategy: debounceStrategy({ wait: 1 }),
        });

        const calls = ["A", "Ad", "Ada 3"].map((title) => mutate({ NoteId: "n1", title }));

        return calls[0] ?? mutate({ NoteId: "n1", title: "Ada 3" });
      }),
      Story.shows(one, [{ title: "Ada 3", pinned: true, $hasPendingWrites: true }]),
      Story.settled(),
      Story.shows(one, [{ title: "Ada 3", pinned: true, $hasPendingWrites: false }]),
      Story.check("one RenameNote sent for three paced calls", (world) => {
        const sent = world.client().wire.sent.filter((each) => each.name === "RenameNote");

        expect(sent).toHaveLength(1);
      }),
    );
  });

  it("f(feed silent, rename) → Unconfirmed once the settle timeout passes; the subset reloads", async () => {
    await story(
      exist(ada),
      Story.open(one),
      Story.mute(),
      Story.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Story.advance(2_000),
      Story.settled("Unconfirmed"),
      Story.advance(10),
      Story.shows(one, [{ title: "Ada 2", $hasPendingWrites: false }]),
    );
  });
});

describe("f(subsets, load) as stories", () => {
  it("f(load in flight, writes race the query) → every write applied once, nothing missed", async () => {
    await story.with({ invariants: Story.invariants })(
      exist(ada, bob),
      Story.hold(),
      Story.open(list),
      Story.state(list, "Loading"),
      // The query answered from the store as it was; these writes land after its cursor.
      Story.remote(refOf(ada), new RenameNote({ NoteId: "n1", title: "Ada 2" })),
      Story.remote(refOf(bob), new DeleteNote({ NoteId: "n2" })),
      Story.remote(
        NoteAggregate.ref(address("acc-1", "n3")),
        new CreateNote({ account: "acc-1", BookId: "b1", title: "Cyd" }),
      ),
      Story.state(list, "Loading"),
      Story.release(),
      Story.state(list, "Ready"),
      // n3 has no rule to place it in the list: the list reloads after its debounce.
      Story.advance(10),
      Story.shows(list, [
        { NoteId: "n1", title: "Ada 2" },
        { NoteId: "n3", title: "Cyd" },
      ]),
    );
  });

  it("f(typed query failure, recover, retry) → the error state, then Ready", async () => {
    await story(
      exist(ada),
      Story.fail("NotesByBook", new QueryRefused()),
      Story.open(book),
      Story.state(book, new QueryRefused()),
      Story.recover("NotesByBook"),
      Story.reload(book),
      Story.state(book, "Ready"),
      Story.shows(book, [{ NoteId: "n1" }]),
    );
  });
});

describe("f(ready subsets, another client's change) as stories", () => {
  it("f(three subsets, server rename then delete) → every subset that shows the row follows", async () => {
    await story.with({ invariants: Story.invariants })(
      exist(ada, bob),
      Story.open(list),
      Story.open(one),
      Story.open(book),
      Story.remote(refOf(ada), new RenameNote({ NoteId: "n1", title: "Ada 2" })),
      Story.shows(list, [{ title: "Ada 2" }, { title: "Bob" }]),
      Story.shows(one, [{ title: "Ada 2" }]),
      Story.shows(book, [{ title: "Ada 2" }]),
      Story.given(refOf(ada), new NoteChanged({ note: { ...ada, title: "Ada 3" } })),
      Story.shows(one, [{ title: "Ada 3" }]),
      Story.remote(refOf(ada), new DeleteNote({ NoteId: "n1" })),
      Story.shows(list, [{ title: "Bob" }]),
      Story.shows(one, []),
      Story.shows(book, []),
    );
  });

  it("f(ready, feed drops; a write meanwhile; feed resumes) → Retrying, then the write, from the last seq", async () => {
    let asked = 0;

    await story.with({ invariants: Story.invariants })(
      exist(ada),
      Story.shows(book, [{ NoteId: "n1" }]),
      Story.check("count the queries", (world) => {
        asked = world.client().wire.asked.length;
      }),
      Story.drop(),
      Story.state(book, "Retrying", { attempt: 2 }),
      Story.remote(
        NoteAggregate.ref(address("acc-1", "n4")),
        new CreateNote({ account: "acc-1", BookId: "b1", title: "Dee" }),
      ),
      Story.shows(book, [{ NoteId: "n1" }]),
      Story.resume(),
      Story.state(book, "Ready"),
      Story.shows(book, [{ NoteId: "n1" }, { NoteId: "n4", title: "Dee" }]),
      Story.check("resumed from its last seq: no reload, the rule placed n4", (world) => {
        expect(world.client().wire.asked).toHaveLength(asked);
      }),
    );
  });

  it("f(two accounts, module-level declarations) → each client follows only its own scope", async () => {
    await story.with({ invariants: Story.invariants })(
      exist(ada, eve),
      Story.shows(book, [{ NoteId: "e1" }, { NoteId: "n1" }]),
      Story.as("acc-2", Story.shows(book, [{ NoteId: "e1" }, { NoteId: "n1" }])),
      Story.when(notes.rename, { NoteId: "n1", title: "Mine" }),
      Story.settled("Committed"),
      Story.as(
        "acc-2",
        Story.remote("rename e1", (api: Client) =>
          api.RenameNote(address("acc-2", "e1"), { NoteId: "e1", title: "Theirs" }),
        ),
        Story.shows(book, [
          { NoteId: "e1", title: "Theirs" },
          { NoteId: "n1", title: "Ada" },
        ]),
      ),
      // Each feed carries only its account's changes.
      Story.shows(book, [
        { NoteId: "e1", title: "Eve" },
        { NoteId: "n1", title: "Mine" },
      ]),
    );
  });

  it("f(alchemy's Story.given and Story.when) → history and another client's write on the host", async () => {
    await story.with({ invariants: Story.invariants })(
      Story.alchemy(Alchemy.given(refOf(ada), new NoteCreated({ note: ada }))),
      Story.shows(one, [{ title: "Ada" }]),
      Story.alchemy(Alchemy.when(refOf(ada), new RenameNote({ NoteId: "n1", title: "Ada 2" }))),
      Story.shows(one, [{ title: "Ada 2", $hasPendingWrites: false }]),
    );
  });

  it("f(server store, check) → a check reads the host's services", async () => {
    await story(
      exist(ada),
      Story.open(stats({ account: "acc-1" })),
      Story.shows(stats({ account: "acc-1" }), [{ count: 1 }]),
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
      Story.open(list),
      Story.open(one),
      Story.check("another write path changes n1 (the feed does not carry it)", async (world) => {
        const notesStore = await world.host.service?.(NoteStore);
        const stored = notesStore?.notes.get("n1");

        if (stored) notesStore?.notes.set("n1", { ...stored, title: "Ada (imported)" });
      }),
      Story.settle(),
      Story.shows(list, [{ title: "Ada" }, { title: "Bob" }]),
      Story.reload(NoteRows),
      Story.shows(list, [{ title: "Ada (imported)" }, { title: "Bob" }]),
      Story.shows(one, [{ title: "Ada (imported)", $hasPendingWrites: false }]),
      Story.check("each subset showed n1 once more, in one transaction", (world) => {
        for (const observed of world.observed())
          expect(Story.historyOf(observed, "n1", ["title"])).toBe(
            '{"title":"Ada"} → {"title":"Ada (imported)"}',
          );
      }),
    );
  });

  it("f(rename in flight, feed muted, story fails) → the failure is reported; closing still ends", async () => {
    // `HighAlch.close` waits for sent commands: the story lets the reply through and runs its
    // clock's waits (here the settle timeout), so the failure surfaces instead of a hang.
    const failure = await story(
      exist(ada),
      Story.open(one),
      Story.mute(),
      Story.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Story.shows(one, [{ title: "Ada" }]),
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
    await ledgerStory.with({ invariants: Story.invariants })(
      saved("e1", "Ada"),
      Story.shows(ledgerList, [{ EntryId: "e1", text: "Ada" }]),
      Story.when(entries.save, { value: { EntryId: "e1", text: "Ada 2" } }),
      Story.shows(ledgerList, [{ text: "Ada 2", $hasPendingWrites: true }]),
      // On the manual clock the settle timeout never passes: Committed is the feed's delivery.
      Story.settled("Committed"),
      Story.shows(ledgerList, [{ text: "Ada 2", $hasPendingWrites: false }]),
      Story.check("the entry names the command as its cause", async (world) => {
        const run = world.runs.at(-1);
        const feed = await world.entries();

        expect(feed.at(-1)?.commandId).toBe(run?.transaction.id);
      }),
    );
  });

  it("f(store refuses, update) → nothing delivered: Unconfirmed after the timeout, reloaded", async () => {
    await ledgerStory(
      saved("e1", "Ada"),
      Story.open(ledgerList),
      Story.check("refuse e1", async (world) => {
        (await world.host.service?.(EntryStore))?.refuse.add("e1");
      }),
      Story.when(entries.save, { value: { EntryId: "e1", text: "Ada 2" } }),
      Story.advance(2_000),
      Story.settled("Unconfirmed"),
      Story.advance(10),
      Story.shows(ledgerList, [{ text: "Ada", $hasPendingWrites: false }]),
    );
  });

  it("f(rejected decision, update) → rolls back with EntryEmpty", async () => {
    await ledgerStory.with({ invariants: Story.invariants })(
      saved("e1", "Ada"),
      Story.open(ledgerList),
      Story.when(entries.save, { value: { EntryId: "e1", text: "" } }),
      Story.rejected(new EntryEmpty()),
      Story.shows(ledgerList, [{ text: "Ada", $hasPendingWrites: false }]),
    );
  });
});

describe("f(story failure) → a readable report", () => {
  it("names the step, expected vs observed, and each key's history", async () => {
    const failure = await story(
      exist(ada),
      Story.open(one),
      Story.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Story.settled("Committed"),
      Story.shows(one, [{ title: "Ada" }]),
    ).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure).toBeInstanceOf(Story.StoryFailure);
    expect(failure?.message).toContain("Step 5 (shows");
    expect(failure?.message).toMatch(
      /expected \[\{"title":"Ada"\}\][\s\S]*observed[\s\S]*n1: \{"title":"Ada"\} → \{"title":"Ada 2"\} \(pending\) → \{"title":"Ada 2"\}[\s\S]*✓ 4\. settled Committed[\s\S]*✗ 5\. shows/,
    );
  });
});

describe("view helpers", () => {
  it("f(view(source, state)) → match reads each state, with the source's typed errors", () => {
    const data = [ada];
    const retry = () => {};

    const shown = [
      Story.view(list, Story.Live.Loading()),
      Story.view(list, Story.Live.Retrying({ error: new QueryRefused(), attempt: 2, data })),
      Story.view(list, Story.Live.Ready({ data, feed: Option.none(), retry })),
      Story.view(list, Story.Live.Ready({ data, feed: Option.some(new QueryRefused()), retry })),
      Story.view(list, new QueryRefused()),
    ].map((result) =>
      HighAlch.match(result).on({
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
    const outcome = (): HighAlch.Settled<undefined> =>
      Story.Settled.Committed({ reply: undefined, stream: "Note/n1", version: 2 });

    const committed = outcome();

    expect(
      HighAlch.match(committed).on({ Committed: () => "saved", Unconfirmed: () => "unconfirmed" }),
    ).toBe("saved");
    expect(Story.Live.Missing()._tag).toBe("Missing");
  });
});
