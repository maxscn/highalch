import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { LowAlchDb } from "@highalch/story/lowalch";
import { Screen } from "@highalch/story/screen";
import { Form } from "@highalch/story/tanstack-form";
import { Db } from "@highalch/story/tanstack-db";
import { ResetOnSubmit } from "@highalch/examples";
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

const { ApprovedRenameForm, renameForm } = ResetOnSubmit;

const story = Story.make(LowAlchDb.memory({ api: NotesApi, layer: notebook, services: store }), {
  scope: "acc-1",
});

/** The forms are mounted, never painted: no story here compares a frame. */
const View = Screen.make({ width: 360, height: 120 });

const ada: Note = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada", pinned: false };

const bob: Note = { NoteId: "n2", account: "acc-1", BookId: "b2", title: "Bob", pinned: false };

const exist = (...seeded: ReadonlyArray<Note>) =>
  seeded.map((note) =>
    Story.given(NoteAggregate.ref(address(note.account, note.NoteId)), new NoteCreated({ note })),
  );

const list = notes.list({ account: "acc-1" });

describe("f(form steps) → the app's own form, found without wiring", () => {
  it("f(type, submit, rejected) → the approved form keeps the draft", async () => {
    await story.with({ name: "form keeps draft", rules: Db.rules })(
      exist(ada),
      Db.open(list),
      View.render(<ApprovedRenameForm NoteId="n1" title="Ada" />),
      Form.then(renameForm, { values: { title: "Ada" }, canSubmit: true }),
      Form.when(renameForm, "title", "locked"),
      Form.submit(renameForm),
      Db.rejected(new NoteLocked({ title: "locked" })),
      Form.then(renameForm, { values: { title: "locked" } }),
      Db.then(list, [{ title: "Ada", $hasPendingWrites: false }]),
    );
  });

  it("f(two instances, no where) → fails listing them; Form.where picks one", async () => {
    const failure = await story
      .with({ name: "two forms" })(
        exist(ada, bob),
        View.render(
          <>
            <ApprovedRenameForm NoteId="n1" title="Ada" />
            <ApprovedRenameForm NoteId="n2" title="Bob" />
          </>,
        ),
        Form.when(renameForm, "title", "x"),
      )
      .then(
        () => undefined,
        (error: Story.StoryFailure) => error,
      );

    expect(failure?.message).toContain("2 mounted instances of renameForm");
    expect(failure?.message).toContain(
      'renameForm #1 (NoteId: "n1", title: "Ada"); renameForm #2 (NoteId: "n2", title: "Bob")',
    );

    await story.with({ name: "two forms where" })(
      exist(ada, bob),
      View.render(
        <>
          <ApprovedRenameForm NoteId="n1" title="Ada" />
          <ApprovedRenameForm NoteId="n2" title="Bob" />
        </>,
      ),
      Form.when(
        Form.where(renameForm, (values) => values.NoteId === "n2"),
        "title",
        "Bob 2",
      ),
      Form.then(
        Form.where(renameForm, (values) => values.NoteId === "n2"),
        {
          values: { title: "Bob 2" },
        },
      ),
      Form.then(
        Form.where(renameForm, (values) => values.NoteId === "n1"),
        {
          values: { title: "Ada" },
        },
      ),
    );
  });
});

describe("f(Form.typing) → a source of what typing can do", () => {
  it("f(Effect Schema validator) → values sampled, the same on every run", () => {
    const sampled = Form.typing(renameForm, { fields: ["title"] });
    const again = Form.typing(renameForm, { fields: ["title"] });

    expect(sampled.values).toHaveLength(3);
    expect(sampled.values).toEqual(again.values);
    expect(
      sampled.values.every(
        (move) =>
          typeof move === "object" &&
          move !== null &&
          "value" in move &&
          typeof move.value === "string" &&
          move.value.length > 0,
      ),
    ).toBe(true);
  });
});
