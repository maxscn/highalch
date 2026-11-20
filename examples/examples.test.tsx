import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Db } from "@highalch/story/tanstack-db";
import { Machine } from "@highalch/story/xstate";
import { NoteLocked } from "../fixtures/notebook";
import { notes } from "../fixtures/notes";
import * as EmptyWhileLoading from "./empty-while-loading";
import { ada, bob, exist, failureOf, list, screen, story } from "./shared";
import * as StickyOptimistic from "./sticky-optimistic";
import * as SwallowedRejection from "./swallowed-rejection";

/**
 * Each example runs one story against two variants of a view (or machine): the broken one, which
 * the story catches with a readable failure, and the approved one, which passes. Both variants'
 * frames are reviewed baselines under `examples/baselines/takumi/`, so the broken screen and the
 * approved one sit side by side.
 */

describe("example: the list claims to be empty while it loads", () => {
  const List = screen(EmptyWhileLoading.css);

  const loads = (name: string, view: React.JSX.Element) =>
    story.with({ name, invariants: Db.invariants })(
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
    story.with({ name, invariants: Db.invariants })(
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
    story.with({ name, invariants: Db.invariants })(
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
