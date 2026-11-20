import { describe, expect, it } from "vite-plus/test";
import { createAsyncLogic, setup, types } from "xstate";
import * as Story from "@highalch/story";
import { Db } from "@highalch/story/tanstack-db";
import { explore, Machine, pathsOf } from "@highalch/story/xstate";
import { mark } from "@lowalch/tanstack-db/xstate";
import { editor } from "../../../fixtures/editor";
import {
  address,
  DeleteNote,
  NoteAggregate,
  NoteCreated,
  NoteLocked,
  NoteMissing,
  NotesApi,
  RenameNote,
  notebook,
  store,
  type Note,
} from "../../../fixtures/notebook";
import { notes } from "../../../fixtures/notes";

/** The hosted runner: the Notebook model in memory, data and machine steps in any order. */
const story = Story.make(Story.memory({ api: NotesApi, layer: notebook, services: store }), {
  scope: "acc-1",
});

/** The hostless runner: no Domain, no client, nothing started; machines are stepped purely. */
const pure = Story.make();

const ada: Note = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada", pinned: false };

const bob: Note = { NoteId: "n2", account: "acc-1", BookId: "b2", title: "Bob", pinned: false };

const n2 = NoteAggregate.ref(address("acc-1", "n2"));

const n1 = NoteAggregate.ref(address("acc-1", "n1"));

const one = notes.get({ NoteId: "n1" });

const list = notes.list({ account: "acc-1" });

const book = notes.byBook({ BookId: "b1" });

const editing = { NoteId: "n1", draft: "Ada 2", problem: undefined };

describe("f(editor snapshot, event) → next snapshot and the commands it asked for (pure)", () => {
  it("f(Editing, Save) → Saving, asking for rename with the draft", async () => {
    await pure(
      Machine.given(editor, { state: "Editing", context: editing }),
      Machine.when({ type: "Save" }),
      Machine.then({ state: "Saving", context: { draft: "Ada 2" } }),
      Machine.asked(notes.rename, { NoteId: "n1", title: "Ada 2" }),
    );
  });

  it("f(Idle, Edit) → Editing with the draft, asking for nothing", async () => {
    await pure(
      Machine.given(editor, { input: { NoteId: "n1" } }),
      Machine.then({ state: "Idle" }),
      Machine.when({ type: "Edit", title: "Ada 2" }),
      Machine.then({ state: "Editing", context: { draft: "Ada 2" } }),
      Machine.askedNothing(),
    );
  });

  it("f(Saving, rename settled | NoteMissing | NoteLocked) → Saved | Stale | Failed", async () => {
    const saving = [
      Machine.given(editor, { state: "Editing", context: editing }),
      Machine.when({ type: "Save" }),
    ];

    await pure(
      saving,
      Machine.done(
        notes.rename,
        Db.Settled.Committed({ reply: undefined, stream: "", version: 2 }),
      ),
      Machine.then({ state: "Saved", context: { problem: undefined } }),
    );

    await pure(
      saving,
      Machine.failed(notes.rename, new NoteMissing()),
      Machine.then({ state: "Stale", context: { problem: "NoteMissing" } }),
    );

    await pure(
      saving,
      Machine.failed(notes.rename, new NoteLocked({ title: "Ada 2" })),
      Machine.then({ state: "Failed", context: { problem: "NoteLocked" } }),
      Machine.when({ type: "Edit", title: "Ada 3" }),
      Machine.then({ state: "Editing", context: { draft: "Ada 3", problem: undefined } }),
    );
  });

  it("f(plain XState logic marked with its command) → asked works the same", async () => {
    const saver = setup({
      schemas: { context: types<{ readonly title: string }>(), events: { Save: types<void>() } },
      actors: {
        rename: mark(
          createAsyncLogic({
            run: async ({ input }: { readonly input: { NoteId: string; title: string } }) =>
              notes.rename.result(input),
          }),
          notes.rename,
        ),
      },
    }).createMachine({
      id: "saver",
      context: { title: "Ada 2" },
      initial: "Idle",
      states: {
        Idle: { on: { Save: () => ({ target: "Saving" }) } },
        Saving: {
          invoke: {
            src: "rename",
            input: ({ context }) => ({ NoteId: "n1", title: context.title }),
          },
        },
      },
    });

    await pure(
      Machine.given(saver),
      Machine.when({ type: "Save" }),
      Machine.then({ state: "Saving" }),
      Machine.asked(notes.rename, { NoteId: "n1", title: "Ada 2" }),
    );
  });

  it("f(failing expectation) → a readable report", async () => {
    const failure = await pure(
      Machine.given(editor, { state: "Editing", context: editing }),
      Machine.when({ type: "Save" }),
      Machine.asked(notes.rename, { title: "something else" }),
    ).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.message).toMatch(
      /Step 3 \(asked \{"title":"something else"\}\) failed: editor \(stepped\) did not ask for rename with that input[\s\S]*expected rename \{"title":"something else"\}[\s\S]*observed rename \{"NoteId":"n1","title":"Ada 2"\}[\s\S]*machine editor \(stepped\) is "Saving"/,
    );
  });

  it("f(wrong state expected) → names the machine, expected vs observed state and what it asked for", async () => {
    const failure = await pure(
      Machine.given(editor, { state: "Editing", context: editing }, { name: "draft" }),
      Machine.when({ type: "Save" }, { machine: "draft" }),
      Machine.then({ state: "Saved" }, { machine: "draft" }),
    ).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.message).toMatch(
      /Step 3 \(draft: machine is "Saved"\) failed: draft \(stepped\) is not in the expected state[\s\S]*expected "Saved"[\s\S]*observed "Saving"[\s\S]*asked since its last event: rename \{"NoteId":"n1","title":"Ada 2"\}/,
    );
  });
});

describe("f(hostless story, step that needs a host) → a clear error naming the step", () => {
  it("f(stepped editor, shows) → step 2 fails: a data step needs a host", async () => {
    const failure = await pure(
      Machine.given(editor, { input: { NoteId: "n1" } }),
      Db.then(one, [{ title: "Ada" }]),
      Machine.then({ state: "Idle" }),
    ).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.step).toBe(2);
    expect(failure?.message).toMatch(
      /Step 2 \(then NoteRows\/NoteById[^\n]*\) failed: "then NoteRows\/NoteById[^\n]*" needs a host, and this story has none[\s\S]*✓ 1\. given editor stepped purely[\s\S]*✗ 2\. then[\s\S]* {3}3\. machine is "Idle"/,
    );
  });

  it("f(Machine.start) → a running machine needs a host too", async () => {
    const failure = await pure(Machine.start(editor, { input: { NoteId: "n1" } })).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.message).toContain('"start editor running" needs a host');
  });

  it("f(hostless.with(options)) → refused: it has no clients or invariants", () => {
    expect(() => pure.with({ invariants: Db.invariants })).toThrow(/hostless story/);
  });
});

describe("f(server history, running editor, data) → one story", () => {
  it("f(n1, edit + save) → Saving with the row pending, then Saved with the committed row", async () => {
    await story.with({ invariants: Db.invariants })(
      Story.given(n1, new NoteCreated({ note: ada })),
      Db.then(one, [{ title: "Ada" }]),
      Machine.start(editor, { input: { NoteId: "n1" } }),
      Machine.when({ type: "Edit", title: "Ada 2" }),
      Machine.when({ type: "Save" }),
      Machine.then({ state: "Saving" }),
      Machine.asked(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: true }]),
      Db.settled("Committed"),
      Machine.then({ state: "Saved" }),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: false }]),
    );
  });

  it("f(n1, save a locked title) → NoteLocked: the row rolls back, the editor Failed", async () => {
    await story.with({ invariants: Db.invariants })(
      Story.given(n1, new NoteCreated({ note: ada })),
      Db.open(one),
      Machine.start(editor, { input: { NoteId: "n1" } }),
      Machine.when({ type: "Edit", title: "locked" }),
      Machine.when({ type: "Save" }),
      Db.then(one, [{ title: "locked", $hasPendingWrites: true }]),
      Db.rejected(new NoteLocked({ title: "locked" })),
      Machine.then({ state: "Failed", context: { problem: "NoteLocked" } }),
      Db.then(one, [{ title: "Ada", $hasPendingWrites: false }]),
    );
  });

  it("f(n1 deleted by another client while editing, save) → NoteMissing: the editor is Stale", async () => {
    await story.with({ invariants: Db.invariants })(
      Story.given(n1, new NoteCreated({ note: ada })),
      Db.open(list),
      Machine.start(editor, { input: { NoteId: "n1" } }),
      Machine.when({ type: "Edit", title: "Ada 2" }),
      Story.remote(n1, new DeleteNote({ NoteId: "n1" })),
      Db.then(list, []),
      Machine.when({ type: "Save" }),
      Db.rejected(new NoteMissing()),
      Machine.then({ state: "Stale", context: { problem: "NoteMissing" } }),
      Db.then(list, []),
    );
  });
});

describe("f(machines and data in one story) → what only the combination shows", () => {
  it("f(row changed by another client, editor stepped purely) → asks to save what the collection shows; nothing runs", async () => {
    await story.with({ invariants: Db.invariants })(
      Story.given(n1, new NoteCreated({ note: ada })),
      Db.open(one),
      Story.remote(n1, new RenameNote({ NoteId: "n1", title: "Ada (theirs)" })),
      Db.then(one, [{ title: "Ada (theirs)", $hasPendingWrites: false }]),
      Machine.given(editor, { input: { NoteId: "n1" } }),
      // The user appends to the title the list shows now.
      Machine.when(async (read) => ({
        type: "Edit",
        title: `${(await read(one))[0]?.title ?? ""}, edited`,
      })),
      Machine.when({ type: "Save" }),
      Machine.then({ state: "Saving", context: { draft: "Ada (theirs), edited" } }),
      Machine.asked(notes.rename, { NoteId: "n1", title: "Ada (theirs), edited" }),
      // Stepped purely: the command was not sent, the row is untouched.
      Db.then(one, [{ title: "Ada (theirs)", $hasPendingWrites: false }]),
      Machine.done(
        notes.rename,
        Db.Settled.Committed({ reply: undefined, stream: "", version: 3 }),
      ),
      Machine.then({ state: "Saved" }),
      Story.check("nothing was sent", (world) => {
        expect(world.wire().sent).toEqual([]);
      }),
    );
  });

  it("f(running editor, another client's write, feed drop/resume, typed rejection) → machine, rows and outcomes agree at every step", async () => {
    await story.with({ invariants: Db.invariants })(
      Story.given(n1, new NoteCreated({ note: ada })),
      Db.open(one),
      Machine.start(editor, { input: { NoteId: "n1" } }),
      Machine.when({ type: "Edit", title: "Ada 2" }),
      Story.remote(n1, new RenameNote({ NoteId: "n1", title: "Ada (theirs)" })),
      Db.then(one, [{ title: "Ada (theirs)", $hasPendingWrites: false }]),
      Machine.then({ state: "Editing", context: { draft: "Ada 2" } }),
      Story.drop(),
      Db.then(one, { state: "Retrying" }),
      Machine.when({ type: "Save" }),
      Machine.then({ state: "Saving" }),
      Machine.asked(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: true }]),
      // The feed is down: the rename is accepted but not confirmed until it resumes.
      Story.resume(),
      Db.settled("Committed"),
      Machine.then({ state: "Saved" }),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: false }]),
      Machine.when({ type: "Edit", title: "locked" }),
      Machine.when({ type: "Save" }),
      Machine.asked(notes.rename, { title: "locked" }),
      Db.then(one, [{ title: "locked", $hasPendingWrites: true }]),
      Db.rejected(new NoteLocked({ title: "locked" })),
      Machine.then({ state: "Failed", context: { problem: "NoteLocked" } }),
      Db.then(one, [{ title: "Ada 2", $hasPendingWrites: false }]),
    );
  });

  it("f(two running editors) → each addressed by name (else the latest); asks, rows and outcomes stay apart", async () => {
    await story.with({ invariants: Db.invariants })(
      Story.given(n1, new NoteCreated({ note: ada })),
      Story.given(n2, new NoteCreated({ note: bob })),
      Db.open(list),
      Machine.start(editor, { input: { NoteId: "n1" }, name: "ada" }),
      Machine.start(editor, { input: { NoteId: "n2" }, name: "bob" }),
      Machine.when({ type: "Edit", title: "Ada 2" }, { machine: "ada" }),
      // Unnamed: the machine introduced last (bob).
      Machine.when({ type: "Edit", title: "locked" }),
      Machine.when({ type: "Save" }, { machine: "ada" }),
      Machine.asked(notes.rename, { NoteId: "n1", title: "Ada 2" }, { machine: "ada" }),
      Machine.askedNothing({ machine: "bob" }),
      Machine.then({ state: "Editing", context: { NoteId: "n2", draft: "locked" } }),
      Db.settled("Committed"),
      Machine.then({ state: "Saved" }, { machine: "ada" }),
      Machine.when({ type: "Save" }, { machine: "bob" }),
      Machine.asked(notes.rename, { NoteId: "n2", title: "locked" }, { machine: "bob" }),
      Db.then(list, [
        { NoteId: "n1", title: "Ada 2", $hasPendingWrites: false },
        { NoteId: "n2", title: "locked", $hasPendingWrites: true },
      ]),
      Db.rejected(new NoteLocked({ title: "locked" })),
      Machine.then({ state: "Failed", context: { problem: "NoteLocked" } }, { machine: "bob" }),
      Machine.then({ state: "Saved" }, { machine: "ada" }),
      Db.then(list, [
        { NoteId: "n1", title: "Ada 2", $hasPendingWrites: false },
        { NoteId: "n2", title: "Bob", $hasPendingWrites: false },
      ]),
    );
  });

  it("f(running editor, Machine.done) → a clear error: its command settles by itself", async () => {
    const failure = await story(
      Story.given(n1, new NoteCreated({ note: ada })),
      Machine.start(editor, { input: { NoteId: "n1" } }),
      Machine.when({ type: "Edit", title: "Ada 2" }),
      Machine.when({ type: "Save" }),
      Machine.failed(notes.rename, new NoteMissing()),
    ).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.message).toMatch(
      /Step 5 \(command failed with NoteMissing\) failed: Machine\.failed feeds a result to a machine stepped purely; editor is running/,
    );
  });

  it("f(unknown machine name) → a clear error listing the machines", async () => {
    const failure = await pure(
      Machine.given(editor, {}, { name: "draft" }),
      Machine.then({ state: "Idle" }, { machine: "other" }),
    ).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.message).toMatch(
      /the story has no machine named "other"[\s\S]*machines: draft/,
    );
  });
});

/**
 * What can happen to one note while it is shown: a local edit, another client's change, the feed
 * dropping and resuming, a rejected local edit. The model allows three events (it must be finite),
 * knows whether the feed is up (which decides what may happen next) and records what happened, so
 * each order of events is its own state and every interleaving is a path.
 */
const bound = 3;

type Happened = {
  readonly count: number;
  readonly feed: "up" | "down";
  readonly trail: string;
};

const counted = (context: Happened, feed: Happened["feed"], what: string) => {
  if (context.count >= bound) return undefined;

  return { context: { count: context.count + 1, feed, trail: `${context.trail} ${what}` } };
};

const happenings = setup({
  schemas: {
    context: types<Happened>(),
    events: {
      EDIT: types<void>(),
      REMOTE: types<void>(),
      DROP: types<void>(),
      RESUME: types<void>(),
      REJECT: types<void>(),
    },
  },
}).createMachine({
  id: "note",
  context: { count: 0, feed: "up", trail: "" },
  initial: "Shown",
  states: {
    Shown: {
      on: {
        EDIT: ({ context }) => counted(context, context.feed, "EDIT"),
        REMOTE: ({ context }) => counted(context, context.feed, "REMOTE"),
        REJECT: ({ context }) => counted(context, context.feed, "REJECT"),
        DROP: ({ context }) => {
          if (context.feed === "down") return undefined;

          return counted(context, "down", "DROP");
        },
        RESUME: ({ context }) => {
          if (context.feed === "up") return undefined;

          return counted(context, "up", "RESUME");
        },
      },
    },
  },
});

const happeningEvents = [
  { type: "EDIT" },
  { type: "REMOTE" },
  { type: "DROP" },
  { type: "RESUME" },
  { type: "REJECT" },
] as const;

/** The story steps of each modelled event. */
const happen = (event: (typeof happeningEvents)[number], index: number): Story.Steps => {
  if (event.type === "EDIT")
    return Db.when(notes.rename, { NoteId: "n1", title: `local ${index}` });

  if (event.type === "REMOTE")
    return Story.remote(n1, new RenameNote({ NoteId: "n1", title: `remote ${index}` }));

  if (event.type === "DROP") return Story.drop();

  if (event.type === "RESUME") return Story.resume();

  return Db.when(notes.rename, { NoteId: "n1", title: "locked" });
};

const exploration = {
  model: happenings,
  events: happeningEvents,
  steps: happen,
  before: [
    Story.given(n1, new NoteCreated({ note: ada })),
    Db.open(list),
    Db.open(one),
    Db.open(book),
  ],
  after: [Story.resume(), Story.idle()],
  story,
  invariants: Db.invariants,
  maxLength: 3,
};

/**
 * The same model with the local edits made by a running editor: each EDIT (and REJECT) is machine
 * steps, the rest data steps, in one generated story.
 */
const edited = (event: (typeof happeningEvents)[number], index: number): Story.Steps => {
  if (event.type === "EDIT")
    return [
      Machine.when({ type: "Edit", title: `local ${index}` }),
      Machine.when({ type: "Save" }),
    ];

  if (event.type === "REJECT")
    return [Machine.when({ type: "Edit", title: "locked" }), Machine.when({ type: "Save" })];

  return happen(event, index);
};

const machineExploration = {
  ...exploration,
  steps: edited,
  before: [...exploration.before, Machine.start(editor, { input: { NoteId: "n1" } })],
  maxLength: 2,
};

describe("f(model of what happens to a note) → generated stories keep the invariants", () => {
  it("enumerates the same paths every time (xstate/graph), longest first per prefix", () => {
    const paths = pathsOf(happenings, happeningEvents, 3).map((path) =>
      path.map((event) => event.type).join(" "),
    );

    expect(paths).toEqual(
      pathsOf(happenings, happeningEvents, 3).map((path) =>
        path.map((event) => event.type).join(" "),
      ),
    );
    expect(paths).toHaveLength(64);
    expect(paths).toContain("EDIT DROP REMOTE");
    expect(paths).not.toContain("DROP DROP EDIT");
  });

  it("every interleaving of local edit, remote change, feed drop/resume and rejection holds", async () => {
    const explored = await explore(exploration);

    expect(explored.paths).toBe(64);
  }, 120_000);

  it("the same model with a running editor making the edits: machine and data steps per event", async () => {
    const explored = await explore(machineExploration);

    expect(explored.paths).toBe(16);
  }, 120_000);
});
