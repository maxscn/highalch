import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Explore } from "@highalch/story";
import { Screen } from "@highalch/story/screen";
import { Takumi } from "@highalch/story/takumi";
import { Form } from "@highalch/story/tanstack-form";
import { Db } from "@highalch/story/tanstack-db";
import { Machine } from "@highalch/story/xstate";
import {
  EmptyWhileLoading,
  OverflowingTitle,
  Shared,
  StickyOptimistic,
  SwallowedRejection,
} from "@highalch/examples";
import { NoteLocked } from "../../../fixtures/notebook";
import { notes } from "../../../fixtures/notes";

const { ada, bob, exist, failureOf, list, screen, story } = Shared;

/**
 * Each example runs one story against two variants of a view (or machine): the broken one, which
 * the story catches with a readable failure, and the approved one, which passes. Both variants'
 * frames are reviewed baselines under `tests/baselines/takumi/`, so the broken screen and the
 * approved one sit side by side.
 */

describe("example: the list claims to be empty while it loads", () => {
  const List = screen(EmptyWhileLoading.css);

  const loads = (name: string, view: React.JSX.Element) =>
    story.with({ name, rules: Db.rules })(
      exist(ada, bob),
      Story.hold(),
      List.render(view),
      List.check("does not claim the list is empty while it loads", (container) => {
        if (container.textContent?.includes("No notes yet"))
          throw new Error("the list says 'No notes yet' before its first answer arrived");
      }),
      Story.release(),
      Db.then(list, [{ title: "Ada" }, { title: "Bob" }]),
    );

  it("broken: caught at the check, with the empty claim on screen", async () => {
    const failure = await failureOf(
      loads("empty while loading (broken)", <EmptyWhileLoading.BrokenNoteList account="acc-1" />),
    );

    expect(failure?.step).toBe(5);
    expect(failure?.message).toContain(
      "the list says 'No notes yet' before its first answer arrived",
    );
  });

  it("approved: Loading until the answer, then the notes", () =>
    loads(
      "empty while loading (approved)",
      <EmptyWhileLoading.ApprovedNoteList account="acc-1" />,
    ));
});

describe("example: a rejected rename stays on screen", () => {
  const List = screen(StickyOptimistic.css);

  const renamed = (name: string, view: React.JSX.Element) =>
    story.with({ name, rules: Db.rules })(
      exist(ada),
      List.render(view),
      Db.when(notes.rename, { NoteId: "n1", title: "locked" }),
      Db.rejected(new NoteLocked({ title: "locked" })),
      Db.then(list, [{ title: "Ada", $hasPendingWrites: false }]),
      List.check("shows the title the server kept", (container) => {
        const shown = container.querySelector(".title")?.textContent;

        if (shown !== "Ada")
          throw new Error(`the screen shows "${shown}" after the rename was rejected`);
      }),
    );

  it("broken: the collection rolled back, the screen did not", async () => {
    const failure = await failureOf(
      renamed("sticky optimistic (broken)", <StickyOptimistic.BrokenTitles account="acc-1" />),
    );

    expect(failure?.step).toBe(6);
    expect(failure?.message).toContain('the screen shows "locked" after the rename was rejected');
  });

  it("approved: pending, then rolled back on screen too", () =>
    renamed("sticky optimistic (approved)", <StickyOptimistic.ApprovedTitles account="acc-1" />));
});

describe("example: a rejected save says Saved", () => {
  const Editor = screen(SwallowedRejection.css);

  const saved = (name: string, atoms: ReturnType<typeof SwallowedRejection.approvedEditing>) =>
    story.with({ name, rules: Db.rules })(
      exist(ada),
      Machine.mounted(atoms),
      Editor.render(<SwallowedRejection.EditorView atoms={atoms} />),
      Machine.when({ type: "Edit", title: "locked" }),
      Machine.when({ type: "Save" }),
      Db.rejected(new NoteLocked({ title: "locked" })),
      Machine.then({ state: "Failed", context: { problem: "NoteLocked" } }),
    );

  it("broken: the machine is Saved after a rejection", async () => {
    const failure = await failureOf(
      saved("swallowed rejection (broken)", SwallowedRejection.brokenEditing("n1")),
    );

    expect(failure?.step).toBe(7);
    expect(failure?.message).toContain("is not in the expected state");
    expect(failure?.message).toContain('observed "Saved"');
  });

  it("approved: Failed with the typed rejection", () =>
    saved("swallowed rejection (approved)", SwallowedRejection.approvedEditing("n1")));
});

describe("example: a long title runs off its card", () => {
  // Only this example's rule reads a layout, so only its screen has a layout engine.
  const Card = screen(OverflowingTitle.css, 240).pipe(Takumi.layout());

  const fits = Explore.rule("nothing on screen spills out of its box", {
    at: "step",
    reads: { layout: Card.layout() },
    holds: ({ layout }) => Screen.overflowing(layout).length === 0,
  });

  const renamed = (name: string, view: React.JSX.Element) =>
    story.with({ name, rules: [...Db.rules, fits] })(
      exist(ada),
      Card.render(view),
      Form.when(OverflowingTitle.titleForm, "title", "W".repeat(60)),
      Form.submit(OverflowingTitle.titleForm),
      Db.settled("Committed"),
    );

  it("broken: the heading runs off the card once the title shows", async () => {
    const failure = await failureOf(
      renamed(
        "overflowing title (broken)",
        <OverflowingTitle.BrokenNoteCard NoteId="n1" title="Ada" />,
      ),
    );

    expect(failure?.step).toBe(4);
    expect(failure?.message).toContain(
      'main.page > section.card > h1.title: text \\"WWWWWWWWWWWW…\\" (60 characters) runs 788px past its right edge',
    );
  });

  it("approved: the heading wraps inside the card", () =>
    renamed(
      "overflowing title (approved)",
      <OverflowingTitle.ApprovedNoteCard NoteId="n1" title="Ada" />,
    ));
});
