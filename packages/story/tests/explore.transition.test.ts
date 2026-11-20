import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Explore, ExploreFailure } from "@highalch/story";
import { LowAlchDb } from "@highalch/story/lowalch";
import { Db } from "@highalch/story/tanstack-db";
import { Machine } from "@highalch/story/xstate";
import { SwallowedRejection } from "@highalch/examples";
import {
  address,
  NoteAggregate,
  NoteCreated,
  NotesApi,
  notebook,
  RenameNote,
  store,
  type Note,
} from "../../../fixtures/notebook";
import { notes } from "../../../fixtures/notes";

const { approvedEditor, brokenEditor } = SwallowedRejection;

const story = Story.make(LowAlchDb.memory({ api: NotesApi, layer: notebook, services: store }), {
  scope: "acc-1",
});

const ada: Note = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada", pinned: false };

const n1 = NoteAggregate.ref(address("acc-1", "n1"));

const list = notes.list({ account: "acc-1" });

/** What can happen to an editor of n1: the user types and saves, someone else renames, time passes. */
const edit = Explore.source("edit", {
  values: ["Ada 2", "locked"],
  step: (title: string) => Machine.when({ type: "Edit", title }),
});

const save = Explore.source("save", { step: () => Machine.when({ type: "Save" }) });

const settle = Explore.source("settle", { step: () => Story.settle() });

const remote = Explore.source("remote", {
  step: () => Story.remote(n1, new RenameNote({ NoteId: "n1", title: "Ada (theirs)" })),
});

/** The rule the broken editor breaks: it says Saved after its save was rejected. */
const savedMeansCommitted = Explore.rule("an editor says Saved only after its save committed", {
  at: "rest",
  reads: { editor: Machine.snapshot(), commands: Db.commands() },
  holds: ({ editor, commands }) =>
    !editor?.matches("Saved") ||
    ["Committed", "Unconfirmed"].includes(commands.at(-1)?.outcome ?? ""),
});

const explorationOf = (name: string, machine: typeof approvedEditor) => ({
  name,
  story,
  setup: [
    Story.given(n1, new NoteCreated({ note: ada })),
    Db.open(list),
    Machine.start(machine, { input: { NoteId: "n1" } }),
  ],
  sources: [edit, save, settle, remote],
  rules: [...Db.rules, savedMeansCommitted],
  depth: 3,
  artifacts: new URL("../artifacts/explore/", import.meta.url),
});

describe("f(sources, rules) → every sequence explored, a broken rule shrunk and replayed", () => {
  it("f(approved editor) → every sequence of up to 3 moves keeps the rules", async () => {
    const explored = await Explore.run(explorationOf("approved editor", approvedEditor));

    // 5 moves: 5 + 25 + 125 sequences.
    expect(explored).toEqual({ sequences: 155, walks: 0, truncated: false });
  }, 300_000);

  it("f(broken editor) → the shortest failing sequence, as a story, replayed with a trace", async () => {
    const failure = await Explore.run(explorationOf("broken editor", brokenEditor)).then(
      () => undefined,
      (error: ExploreFailure) => error,
    );

    expect(failure).toBeInstanceOf(ExploreFailure);
    expect(failure?.sequence).toEqual(['edit.step("locked")', "save.step()", "settle.step()"]);
    expect(failure?.message).toContain(
      '"an editor says Saved only after its save committed" does not hold',
    );
    expect(failure?.message).toContain('    edit.step("locked"),');

    const trace = readFileSync(failure?.trace ?? "", "utf8");

    expect(existsSync(failure?.trace ?? "")).toBe(true);
    expect(trace).toContain('machine editor (running): "Saved"');
    expect(trace).toContain("command editor: rename: Rejected");
  }, 300_000);

  it("f(walks) → the same seed walks the same sequences", async () => {
    const walked = await Explore.run({
      ...explorationOf("walks", approvedEditor),
      depth: 1,
      walks: { count: 5, length: 6, seed: 7 },
    });

    expect(walked).toEqual({ sequences: 5, walks: 5, truncated: false });
  }, 300_000);
});
