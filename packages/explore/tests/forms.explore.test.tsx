import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Explore, ExploreFailure } from "@highalch/explore";
import { LowAlchDb } from "@highalch/story/lowalch";
import { Screen } from "@highalch/story/screen";
import { Form } from "@highalch/story/tanstack-form";
import { Db } from "@highalch/story/tanstack-db";
import { ResetOnSubmit } from "@highalch/examples";
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

const { ApprovedRenameForm, BrokenRenameForm, renameForm } = ResetOnSubmit;

const story = Story.make(LowAlchDb.memory({ api: NotesApi, layer: notebook, services: store }), {
  scope: "acc-1",
});

/** The forms are mounted, never painted: no story here compares a frame. */
const View = Screen.make({ width: 360, height: 120 });

const ada: Note = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada", pinned: false };

const exist = (...seeded: ReadonlyArray<Note>) =>
  seeded.map((note) =>
    Story.given(NoteAggregate.ref(address(note.account, note.NoteId)), new NoteCreated({ note })),
  );

const list = notes.list({ account: "acc-1" });

/** The rule the broken form breaks. */
const keepsYourDraft = Story.rule(
  "a rejected rename keeps what you typed",
  function* () {
    const commands = yield* Db.commands();

    // Only a rejection is judged: nothing else is read otherwise.
    if (commands.at(-1)?.outcome !== "Rejected") return true;

    const form = yield* Form.state(renameForm);
    const rows = yield* Db.rows(list);

    return form?.values.title !== rows.get("n1")?.title;
  },
  { at: "rest" },
);

const submit = Explore.source("submit", { step: () => Form.submit(renameForm) });

const settle = Explore.source("settle", { step: () => Story.settle() });

/** A form's stories, and how they run. */
const explorationOf = (name: string, view: React.JSX.Element) =>
  [
    Explore.stories(story.with({ name, rules: [...Db.rules, keepsYourDraft] }), {
      setup: [exist(ada), Db.open(list), View.render(view)],
      sources: [
        Form.typing(renameForm, { fields: ["title"], values: { title: ["Ada 2", "locked"] } }),
        submit,
        settle,
      ],
      depth: 3,
    }),
    { artifacts: new URL("../artifacts/explore/", import.meta.url) },
  ] as const;

describe("f(Form.typing, rules) → explored", () => {
  it("f(approved form) → every sequence keeps the rules", async () => {
    const explored = await Explore.run(
      ...explorationOf("approved form", <ApprovedRenameForm NoteId="n1" title="Ada" />),
    );

    expect(explored.checked).toEqual({ sequences: 4 + 16 + 64, depth: 3, complete: true });
  }, 300_000);

  it("f(broken form) → the reset found, shrunk to type, submit, settle", async () => {
    const failure = await Explore.run(
      ...explorationOf("broken form", <BrokenRenameForm NoteId="n1" title="Ada" />),
    ).then(
      () => undefined,
      (error: ExploreFailure) => error,
    );

    expect(failure?.sequence).toEqual([
      'typing.step({"field":"title","instance":0,"value":"locked"})',
      "submit.step()",
      "settle.step()",
    ]);
    expect(failure?.message).toContain('"a rejected rename keeps what you typed" does not hold');
  }, 300_000);
});
