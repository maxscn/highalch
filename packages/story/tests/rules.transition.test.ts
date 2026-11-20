import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Explore } from "@highalch/story";
import { LowAlchDb } from "@highalch/story/lowalch";
import { Db } from "@highalch/story/tanstack-db";
import { Machine } from "@highalch/story/xstate";
import { editor } from "../../../fixtures/editor";
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
import { tagOf } from "../src/steps";

const story = Story.make(LowAlchDb.memory({ api: NotesApi, layer: notebook, services: store }), {
  scope: "acc-1",
});

const ada: Note = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada", pinned: false };

const n1 = NoteAggregate.ref(address("acc-1", "n1"));

const list = notes.list({ account: "acc-1" });

/**
 * A transition rule: it reads the step that just ran and the list before it. A title changes only
 * on a step that writes or settles a write.
 */
const titlesChangeOnWrites = Explore.rule("a title changes only when something writes it", {
  reads: { list: Db.rows(list) },
  holds: ({ step, list: now, previous }) =>
    now.get("n1")?.title === previous.list.get("n1")?.title ||
    ["Given", "Open", "When", "Rejected", "Settled", "Remote"].includes(step._tag),
});

/** A transition rule on the step alone: a rejection leaves nothing pending. */
const rejectionLeavesNothingPending = Explore.rule("a rejection leaves nothing pending", {
  reads: { list: Db.rows(list) },
  holds: ({ step, list: now }) =>
    step._tag !== "Rejected" || [...now.values()].every((row) => !row.$hasPendingWrites),
});

/** A rest rule: only judged when nothing is in flight. */
const nothingSavingAtRest = Explore.rule("no title is saving at rest", {
  at: "rest",
  reads: { list: Db.rows(list) },
  holds: ({ list: now }) => [...now.values()].every((row) => !row.$hasPendingWrites),
});

/** An end rule: the story ran its course, its replies arrived and its timers fired. */
const everySaveEnds = Explore.rule("every save ends", {
  at: "end",
  reads: { machine: Machine.snapshot() },
  holds: ({ machine }) => !machine?.matches("Saving"),
});

describe("f(story, rules) → each rule checked at its moment", () => {
  it("f(rename rejected) → the transition, rest and end rules hold", async () => {
    await story.with({
      rules: [
        ...Db.rules,
        titlesChangeOnWrites,
        rejectionLeavesNothingPending,
        nothingSavingAtRest,
      ],
    })(
      Story.given(n1, new NoteCreated({ note: ada })),
      Db.open(list),
      Db.when(notes.rename, { NoteId: "n1", title: "locked" }),
      // Pending here: the rest rule is not judged, since a command is in flight.
      Db.then(list, [{ title: "locked", $hasPendingWrites: true }]),
      Db.rejected(new NoteLocked({ title: "locked" })),
    );
  });

  it("f(save left in flight) → the end rule sees it end: replies arrive, timers fire", async () => {
    await story.with({ rules: [everySaveEnds] })(
      Story.given(n1, new NoteCreated({ note: ada })),
      Machine.start(editor, { input: { NoteId: "n1" } }),
      Machine.when({ type: "Edit", title: "Ada 2" }),
      Machine.when({ type: "Save" }),
      Machine.then({ state: "Saving" }),
    );
  });

  it("f(a rule that breaks) → the failure names it by its sentence and shows what it read", async () => {
    const titleIsAda = Explore.rule("the title stays Ada", {
      reads: { list: Db.rows(list) },
      holds: ({ list: now }) => [undefined, "Ada"].includes(now.get("n1")?.title),
    });

    const failure = await story
      .with({ rules: [titleIsAda] })(
        Story.given(n1, new NoteCreated({ note: ada })),
        Db.open(list),
        Db.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      )
      .then(
        () => undefined,
        (error: Story.StoryFailure) => error,
      );

    expect(failure?.step).toBe(3);
    expect(failure?.message).toContain(
      'After step 3 (when {"NoteId":"n1","title":"Ada 2"}), "the title stays Ada" does not hold',
    );
    expect(failure?.message).toContain('"title":"Ada 2"');
  });

  it("f(command in flight to the end) → a rest rule is never judged", async () => {
    const failure = await story
      .with({ rules: Db.rules })(
        Story.given(n1, new NoteCreated({ note: ada })),
        Db.open(list),
        Db.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
        Db.then(list, [{ title: "Ada 2", $hasPendingWrites: true }]),
      )
      .then(
        () => undefined,
        (error: Story.StoryFailure) => error,
      );

    // The rename is in flight after every step and at the end: never at rest, so never judged.
    expect(failure).toBeUndefined();
  });
});

describe("f(step label) → its kind, as a rule's step._tag reads it", () => {
  it("names each step by its verb", () => {
    expect(tagOf('when {"NoteId":"n1"}')).toBe("When");
    expect(tagOf("rejected NoteLocked")).toBe("Rejected");
    expect(tagOf("editor: send Save")).toBe("Send");
    expect(tagOf("[acc-2] remote Note/n1: RenameNote")).toBe("Remote");
    expect(tagOf("")).toBe("Step");
  });
});

describe("f(story, trace: true) → a text snapshot of every step, compared like a baseline", () => {
  const traced = (traces: URL) =>
    story.with({
      name: "rename traced",
      trace: true,
      traces,
      update: process.env.UPDATE_SCREENS === "1",
    })(
      Story.given(n1, new NoteCreated({ note: ada })),
      Db.open(list),
      Db.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
      Db.settled("Committed"),
    );

  it("f(the reviewed trace) → matches", () => traced(new URL("./traces/", import.meta.url)));

  it("f(a different trace) → fails at the first differing line, with the actual beside it", async () => {
    const elsewhere = new URL("../artifacts/traces-test/", import.meta.url);

    await writeFile(
      new URL("rename-traced.trace.txt", elsewhere),
      "1. given something else\n",
    ).catch(async () => {
      await mkdir(elsewhere, { recursive: true });
      await writeFile(new URL("rename-traced.trace.txt", elsewhere), "1. given something else\n");
    });

    const failure = await traced(elsewhere).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain(
      "the trace differs from its snapshot rename-traced.trace.txt",
    );
  });
});
