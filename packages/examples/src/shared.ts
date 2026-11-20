import * as Story from "@highalch/story";
import { LowAlchDb } from "@highalch/story/lowalch";
import { Screen } from "@highalch/story/screen";
import { Takumi } from "@highalch/story/takumi";
import {
  address,
  NoteAggregate,
  NoteCreated,
  NotesApi,
  notebook,
  store,
  type Note,
} from "../../../fixtures/notebook";
import { notes } from "../../../fixtures/notes";

/**
 * The examples' story runner: the Notebook Domain in memory with LowAlch clients, one account.
 * Each example is a pair of components (or machines): the broken one a story catches, and the
 * approved one the same story passes.
 */
export const story = Story.make(
  LowAlchDb.memory({ api: NotesApi, layer: notebook, services: store }),
  { scope: "acc-1" },
);

export const ada: Note = {
  NoteId: "n1",
  account: "acc-1",
  BookId: "b1",
  title: "Ada",
  pinned: false,
};

export const bob: Note = {
  NoteId: "n2",
  account: "acc-1",
  BookId: "b2",
  title: "Bob",
  pinned: false,
};

/** History: these notes exist before the story starts. */
export const exist = (...seeded: ReadonlyArray<Note>) =>
  seeded.map((note) =>
    Story.given(NoteAggregate.ref(address(note.account, note.NoteId)), new NoteCreated({ note })),
  );

/** The account's whole list, as the views read it. */
export const list = notes.list({ account: "acc-1" });

/**
 * A screen for the examples: frames compared with the reviewed baselines under
 * `examples/baselines/<painter>/<story>/`, both variants' frames; the run's filmstrips go to
 * `examples/artifacts/` (ignored). `UPDATE_SCREENS=1` writes baselines.
 */
export const screen = (css: string) =>
  Screen.make({
    css,
    width: 360,
    height: 200,
    painter: Takumi.layer(),
    baselines: new URL("../tests/baselines/", import.meta.url),
    output: new URL("../artifacts/", import.meta.url),
    update: process.env.UPDATE_SCREENS === "1",
  });

/** A story's failure, or `undefined` when it passed. */
export const failureOf = (run: Promise<void>) =>
  run.then(
    () => undefined,
    (error: Story.StoryFailure) => error,
  );
