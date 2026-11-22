import { describe, expect, it } from "vite-plus/test";
import { setup, types } from "xstate";
import * as Story from "@highalch/story";
import { Db } from "@highalch/story/tanstack-db";
import { LowAlchDb } from "@highalch/story/lowalch";
import { explore, pathsOf } from "@highalch/explore/xstate";
import { Machine } from "@highalch/story/xstate";
import { editor } from "../../../fixtures/editor";
import {
  address,
  NoteAggregate,
  NoteCreated,
  NotesApi,
  RenameNote,
  notebook,
  store,
  type Note,
} from "../../../fixtures/notebook";
import { notes } from "../../../fixtures/notes";

/** The hosted runner: the Notebook model in memory, data and machine steps in any order. */
const story = Story.make(LowAlchDb.memory({ api: NotesApi, layer: notebook, services: store }), {
  scope: "acc-1",
});

const ada: Note = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada", pinned: false };

const n1 = NoteAggregate.ref(address("acc-1", "n1"));

const one = notes.get({ NoteId: "n1" });

const list = notes.list({ account: "acc-1" });

const book = notes.byBook({ BookId: "b1" });

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
  rules: Db.rules,
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

describe("f(model of what happens to a note) → generated stories keep the rules", () => {
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
