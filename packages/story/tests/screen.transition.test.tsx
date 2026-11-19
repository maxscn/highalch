import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import * as Screen from "@highalch/story/screen";
import { install, serialize } from "../src/screen/dom";
import { Machine } from "@highalch/story/xstate";
import { editor } from "../../../fixtures/editor";
import { css, NoteList } from "../../../fixtures/note-list";
import {
  address,
  NoteAggregate,
  NoteCreated,
  NoteLocked,
  NotesApi,
  notebook,
  store,
  type Note,
} from "../../../fixtures/notebook";
import { notes } from "../../../fixtures/notes";

/**
 * Screen stories: the demo note list mounted against each story's own client, a frame painted by
 * takumi after every step and compared with the reviewed baselines in `tests/baselines`.
 * `UPDATE_SCREENS=1` rewrites them; the filmstrips land in `artifacts/stories` (ignored).
 */
const story = Story.make(Story.memory({ api: NotesApi, layer: notebook, services: store }), {
  scope: "acc-1",
});

const screen = Screen.make({
  css,
  width: 360,
  height: 200,
  baselines: new URL("./baselines/", import.meta.url),
  output: new URL("../artifacts/stories/", import.meta.url),
  update: process.env.UPDATE_SCREENS === "1",
});

const ada: Note = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada", pinned: false };

const bob: Note = { NoteId: "n2", account: "acc-1", BookId: "b2", title: "Bob", pinned: false };

const exist = (...seeded: ReadonlyArray<Note>) =>
  seeded.map((note) =>
    Story.given(NoteAggregate.ref(address(note.account, note.NoteId)), new NoteCreated({ note })),
  );

const list = notes.list({ account: "acc-1" });

describe("f(story steps) → a frame of the mounted note list after each", () => {
  it("f(query held, released) → Loading, then the notes", async () => {
    await story.with({ name: "list loads", invariants: Story.invariants })(
      exist(ada, bob),
      Story.hold(),
      screen.render(<NoteList account="acc-1" />),
      Story.release(),
      Story.shows(list, [{ title: "Ada" }, { title: "Bob" }]),
    );
  });

  it("f(rename) → pending, then committed", async () => {
    await story.with({ name: "rename settles", invariants: Story.invariants })(
      exist(ada, bob),
      screen.render(<NoteList account="acc-1" />),
      Story.when(notes.rename, { NoteId: "n1", title: "Ada Lovelace" }),
      Story.settled("Committed"),
    );
  });

  it("f(locked rename) → pending, then rolled back", async () => {
    await story.with({ name: "rename is rejected", invariants: Story.invariants })(
      exist(ada, bob),
      screen.render(<NoteList account="acc-1" />),
      Story.when(notes.rename, { NoteId: "n1", title: "locked" }),
      Story.rejected(new NoteLocked({ title: "locked" })),
    );
  });

  // `Retrying` is a ready source whose feed is retrying: a query failing on its first load stays
  // `Loading` while it retries, and a failed `reload` of a ready list keeps showing `Ready`.
  it("f(shown, feed drops with a transport error, resumes) → Retrying, then the notes", async () => {
    await story.with({ name: "list retries" })(
      exist(ada),
      screen.render(<NoteList account="acc-1" />),
      Story.drop(),
      Story.state(list, "Retrying"),
      Story.resume(),
      Story.state(list, "Ready"),
    );
  });

  it("f(first load fails with a transport error, recovers) → Loading while it retries, then the notes", async () => {
    await story.with({ name: "list recovers" })(
      exist(ada),
      Story.fail("Notes", Story.transport()),
      screen.render(<NoteList account="acc-1" />),
      Story.state(list, "Loading"),
      Story.recover("Notes"),
      Story.advance(100),
      Story.state(list, "Ready"),
    );
  });

  it("f(running editor, frames only where asked) → shot steps beside machine steps", async () => {
    await story.with({ name: "editor saves" })(
      exist(ada),
      screen.render(<NoteList account="acc-1" />, { every: false }),
      Machine.start(editor, { input: { NoteId: "n1" } }),
      Machine.when({ type: "Edit", title: "Ada 2" }),
      Machine.when({ type: "Save" }),
      screen.shot("saving"),
      Story.settled("Committed"),
      Machine.then({ state: "Saved" }),
      screen.shot("saved"),
    );
  });
});

describe("f(screen misuse) → clear errors", () => {
  it("f(render in a story without a name) → fails naming the step", async () => {
    const failure = await story(exist(ada), screen.render(<NoteList account="acc-1" />)).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.message).toContain(
      'Step 2 (render) failed: "render" needs a story name, since frames are named by it',
    );
  });

  it("f(render in a hostless story) → needs a host", async () => {
    const failure = await Story.make()(screen.render(<NoteList account="acc-1" />)).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.message).toContain('"render" needs a host');
  });

  it("f(story ends) → the DOM globals are removed again", async () => {
    await story.with({ name: "rename settles", invariants: Story.invariants })(
      exist(ada, bob),
      screen.render(<NoteList account="acc-1" />),
      Story.when(notes.rename, { NoteId: "n1", title: "Ada Lovelace" }),
      Story.settled("Committed"),
    );

    expect("document" in globalThis).toBe(false);
    expect("HTMLElement" in globalThis).toBe(false);
  });
});

describe("f(mounted controls, serialise) → what the painter is given", () => {
  it("f(input typed into, checkbox checked) → spans with the current values, not stale attributes", () => {
    const dom = install(320, 200);

    try {
      const root = document.createElement("div");

      root.innerHTML =
        '<input class="field" value="old"><input type="checkbox"><input type="password" value="abc"><textarea>old</textarea><select><option>a</option><option selected>b</option></select>';

      const [field, box] = root.querySelectorAll("input");

      if (field) field.value = "typed";

      if (box) box.checked = true;

      expect(serialize(root)).toBe(
        '<span class="field" data-control="input">typed</span><span type="checkbox" data-control="input">☑</span><span type="password" data-control="input">•••</span><span data-control="textarea">old</span><span data-control="select">b</span>',
      );
    } finally {
      void dom.remove();
    }
  });
});
