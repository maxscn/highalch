import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Db } from "@highalch/story/tanstack-db";
import { Screen } from "@highalch/story/screen";
import { install, serialize } from "../src/screen/dom";
import { Machine } from "@highalch/story/xstate";
import { editor } from "../../../fixtures/editor";
import { css as editorCss, editing, NoteEditor } from "../../../fixtures/note-editor";
import { css, NoteList, SuspendingNoteList } from "../../../fixtures/note-list";
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

const List = Screen.make({
  css,
  width: 360,
  height: 200,
  baselines: new URL("./baselines/", import.meta.url),
  output: new URL("../artifacts/stories/", import.meta.url),
  update: process.env.UPDATE_SCREENS === "1",
});

/** The editor's screen: the same places, its own stylesheet. */
const Editor = Screen.make({
  css: editorCss,
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
    await story.with({ name: "list loads", invariants: Db.invariants })(
      exist(ada, bob),
      Story.hold(),
      List.render(<NoteList account="acc-1" />),
      Story.release(),
      Db.then(list, [{ title: "Ada" }, { title: "Bob" }]),
    );
  });

  it("f(query held behind Suspense, released) → the fallback, then the notes", async () => {
    await story.with({ name: "list suspends", invariants: Db.invariants })(
      exist(ada, bob),
      Story.hold(),
      // Frames only where they do not depend on the wall clock: React keeps a fallback it just
      // showed for 300 ms before it reveals content, however soon the data is there.
      List.render(<SuspendingNoteList account="acc-1" />, { every: false }),
      List.shot("fallback"),
      Story.release(),
      Db.then(list, [{ title: "Ada" }, { title: "Bob" }]),
      Story.check("fallback throttle passed", () => new Promise((done) => setTimeout(done, 350))),
      List.shot("list"),
    );
  });

  it("f(rename) → pending, then committed", async () => {
    await story.with({ name: "rename settles", invariants: Db.invariants })(
      exist(ada, bob),
      List.render(<NoteList account="acc-1" />),
      Db.when(notes.rename, { NoteId: "n1", title: "Ada Lovelace" }),
      Db.settled("Committed"),
    );
  });

  it("f(locked rename) → pending, then rolled back", async () => {
    await story.with({ name: "rename is rejected", invariants: Db.invariants })(
      exist(ada, bob),
      List.render(<NoteList account="acc-1" />),
      Db.when(notes.rename, { NoteId: "n1", title: "locked" }),
      Db.rejected(new NoteLocked({ title: "locked" })),
    );
  });

  // `Retrying` is a ready source whose feed is retrying: a query failing on its first load stays
  // `Loading` while it retries, and a failed `reload` of a ready list keeps showing `Ready`.
  it("f(shown, feed drops with a transport error, resumes) → Retrying, then the notes", async () => {
    await story.with({ name: "list retries" })(
      exist(ada),
      List.render(<NoteList account="acc-1" />),
      Story.drop(),
      Db.then(list, { state: "Retrying" }),
      Story.resume(),
      Db.then(list, { state: "Ready" }),
    );
  });

  it("f(first load fails with a transport error, recovers) → Loading while it retries, then the notes", async () => {
    await story.with({ name: "list recovers" })(
      exist(ada),
      Story.fail("Notes", Story.transport()),
      List.render(<NoteList account="acc-1" />),
      Db.then(list, { state: "Loading" }),
      Story.recover("Notes"),
      Story.advance(100),
      Db.then(list, { state: "Ready" }),
    );
  });

  it("f(running editor, frames only where asked) → shot steps beside machine steps", async () => {
    await story.with({ name: "editor saves" })(
      exist(ada),
      List.render(<NoteList account="acc-1" />, { every: false }),
      Machine.start(editor, { input: { NoteId: "n1" } }),
      Machine.when({ type: "Edit", title: "Ada 2" }),
      Machine.when({ type: "Save" }),
      List.shot("saving"),
      Db.settled("Committed"),
      Machine.then({ state: "Saved" }),
      List.shot("saved"),
    );
  });
});

describe("f(a component reading its machine through atoms, machine steps) → a frame of each state", () => {
  it("f(edit, save) → Idle, Editing, Saving, Saved; the rename is the mounted machine's", async () => {
    await story.with({ name: "mounted editor saves", invariants: Db.invariants })(
      exist(ada),
      Db.open(list),
      Machine.mounted(editing("n1")),
      Editor.render(<NoteEditor NoteId="n1" />, { every: false }),
      Machine.then({ state: "Idle" }),
      Editor.shot("idle"),
      Machine.when({ type: "Edit", title: "Ada 2" }),
      Editor.shot("editing"),
      Machine.when({ type: "Save" }),
      Machine.then({ state: "Saving" }),
      Machine.asked(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Db.then(list, [{ title: "Ada 2", $hasPendingWrites: true }]),
      Editor.shot("saving"),
      Db.settled("Committed"),
      Machine.then({ state: "Saved" }),
      Db.then(list, [{ title: "Ada 2", $hasPendingWrites: false }]),
      Editor.shot("saved"),
    );
  });

  it("f(save a locked title) → Failed with the typed rejection, the row rolled back", async () => {
    await story.with({ name: "mounted editor is rejected", invariants: Db.invariants })(
      exist(ada),
      Db.open(list),
      Machine.mounted(editing("n1")),
      Editor.render(<NoteEditor NoteId="n1" />, { every: false }),
      Machine.when({ type: "Edit", title: "locked" }),
      Machine.when({ type: "Save" }),
      Db.rejected(new NoteLocked({ title: "locked" })),
      Machine.then({ state: "Failed", context: { problem: "NoteLocked" } }),
      Db.then(list, [{ title: "Ada", $hasPendingWrites: false }]),
      Editor.shot("failed"),
    );
  });

  it("f(rendered before the machine step) → the same actor: the step's event shows in the component", async () => {
    await story.with({ name: "mounted editor after render" })(
      exist(ada),
      Editor.render(<NoteEditor NoteId="n1" />, { every: false }),
      Machine.mounted(editing("n1")),
      Machine.when({ type: "Edit", title: "Ada 2" }),
      Editor.check("the component shows the draft and the state", (container) => {
        expect(container.querySelector(".field")?.getAttribute("value")).toBe("Ada 2");
        expect(container.querySelector(".status")?.textContent).toBe("Unsaved changes");
      }),
    );
  });

  it("f(two mounted editors of one machine) → each command is recorded as its own machine's", async () => {
    await story(
      exist(ada, bob),
      Db.open(list),
      Machine.mounted(editing("n1"), { name: "ada" }),
      Machine.mounted(editing("n2"), { name: "bob" }),
      Machine.when({ type: "Edit", title: "Ada 2" }, { machine: "ada" }),
      Machine.when({ type: "Edit", title: "Bob 2" }, { machine: "bob" }),
      Machine.when({ type: "Save" }, { machine: "bob" }),
      Machine.asked(notes.rename, { NoteId: "n2", title: "Bob 2" }, { machine: "bob" }),
      Machine.askedNothing({ machine: "ada" }),
      Db.settled("Committed"),
      Machine.then({ state: "Saved" }, { machine: "bob" }),
      Machine.then({ state: "Editing" }, { machine: "ada" }),
    );
  });

  it("f(a second story) → a fresh registry: the editor starts Idle again", async () => {
    await story(exist(ada), Machine.mounted(editing("n1")), Machine.then({ state: "Idle" }));
  });
});

describe("f(mounted DOM, check) → what is rendered, as elements", () => {
  it("f(note list) → the heading is an h1, each note a list item", async () => {
    await story.with({ name: "list is checked" })(
      exist(ada, bob),
      List.render(<NoteList account="acc-1" />, { every: false }),
      List.check("the heading and the notes", (container) => {
        expect(container.querySelector("h1")?.textContent).toBe("Notes");
        expect(
          [...container.querySelectorAll("li .title")].map((each) => each.textContent),
        ).toEqual(["Ada", "Bob"]);
      }),
      Db.when(notes.rename, { NoteId: "n1", title: "Ada Lovelace" }),
      List.check("the pending row is marked", (container) => {
        expect(container.querySelector("li.pending .badge")?.textContent).toBe("saving");
      }),
      Db.settled("Committed"),
      List.check("nothing is pending", (container) => {
        expect(container.querySelector("li.pending")).toBeNull();
      }),
    );
  });

  it("f(a failed expectation) → the step fails with it", async () => {
    const failure = await story
      .with({ name: "check fails" })(
        exist(ada),
        List.render(<NoteList account="acc-1" />, { every: false }),
        List.check("a heading that is not there", (container) => {
          expect(container.querySelector("h2")?.textContent).toBe("Notes");
        }),
      )
      .then(
        () => undefined,
        (error: Story.StoryFailure) => error,
      );

    expect(failure?.message).toContain("Step 3 (check a heading that is not there) failed");
  });

  it("f(check before render) → fails naming what to do", async () => {
    const failure = await story(List.check("too early", () => {})).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.message).toContain("nothing is rendered yet: List.render(element) first");
  });
});

describe("f(screen misuse) → clear errors", () => {
  it("f(render in a story without a name) → fails naming the step", async () => {
    const failure = await story(exist(ada), List.render(<NoteList account="acc-1" />)).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.message).toContain(
      'Step 2 (render) failed: "render" needs a story name, since frames are named by it',
    );
  });

  it("f(render in a hostless story) → needs a host", async () => {
    const failure = await Story.make()(List.render(<NoteList account="acc-1" />)).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.message).toContain('"render" needs a host');
  });

  it("f(story ends) → the DOM globals are removed again", async () => {
    await story.with({ name: "rename settles", invariants: Db.invariants })(
      exist(ada, bob),
      List.render(<NoteList account="acc-1" />),
      Db.when(notes.rename, { NoteId: "n1", title: "Ada Lovelace" }),
      Db.settled("Committed"),
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
