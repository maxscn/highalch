import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Explore, ExploreFailure, ExploreFlaky, ExploreIncomplete } from "@highalch/story";
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
const savedMeansCommitted = Explore.rule(
  "an editor says Saved only after its save committed",
  function* () {
    const editor = yield* Machine.snapshot();

    if (!editor?.matches("Saved")) return true;

    const commands = yield* Db.commands();

    return ["Committed", "Unconfirmed"].includes(commands.at(-1)?.outcome ?? "");
  },
  { at: "rest" },
);

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

    // 5 moves: 5 + 25 + 125 sequences, all of them.
    expect(explored.checked).toEqual({ sequences: 155, depth: 3, complete: true });
    expect(explored.judged["an editor says Saved only after its save committed"]).toBeGreaterThan(
      0,
    );
    expect(explored.report).toContain(
      "Checked: every one of the 155 sequence(s) of up to 3 move(s)",
    );
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

  it("f(sample) → walks from a fixed seed, reported with it", async () => {
    const walked = await Explore.run({
      ...explorationOf("walks", approvedEditor),
      depth: 1,
      sample: { count: 5, length: 6, seed: 7 },
    });

    expect(walked.sampled).toEqual({ sequences: 5, seed: 7 });
    expect(walked.report).toContain("Sampled: 5 walk(s) (seed 7)");
  }, 300_000);
});

describe("f(exploration) → useful, not random", () => {
  it("f(discover, corpus) → a found failure is kept, and every later run replays it first", async () => {
    const corpus = new URL("../artifacts/explore-corpus/", import.meta.url);
    const file = new URL("broken-editor-discovered.explore.txt", corpus);

    await rm(file, { force: true });

    const discovering = {
      ...explorationOf("broken editor discovered", brokenEditor),
      depth: 1,
      // A fixed seed so the test repeats; without one, each run would look somewhere new.
      discover: { count: 200, length: 6, seed: 3 },
      corpus,
    };

    const first = await Explore.run(discovering).then(
      () => undefined,
      (error: ExploreFailure) => error,
    );

    expect(first?.message).toMatch(/found in a discovered walk \(seed \d+\)/);
    expect(first?.message).toContain("added to the corpus");
    // One line: typing "locked", saving, then anything that lets the reply arrive.
    expect(readFileSync(file, "utf8")).toMatch(
      /^\[\["edit","locked"\],\["save",null\],\["\w+",null\]\]\n$/,
    );

    // Without discovering: deterministic, and the corpus sequence fails first.
    const again = await Explore.run({ ...discovering, discover: false }).then(
      () => undefined,
      (error: ExploreFailure) => error,
    );

    expect(again?.message).toContain("found in a corpus sequence (1 of");
  }, 300_000);

  it("f(a failure that does not reproduce) → ExploreFlaky, never retried away", async () => {
    let calls = 0;

    const coin = Explore.source("coin", {
      step: () =>
        Story.step("flip a coin", async () => {
          calls += 1;

          // Fails the first time only: the shrunk sequence's replays pass.
          if (calls === 1) throw new Error("heads");
        }),
    });

    const failure = await Explore.run({
      ...explorationOf("flaky", approvedEditor),
      sources: [coin],
      depth: 1,
    }).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(ExploreFlaky);
    expect(failure?.message).toContain("did not fail the same way on replay 1");
  }, 300_000);

  it("f(rule never judged, budget hit) → ExploreIncomplete, unless allowed", async () => {
    const neverAtEnd = Explore.rule(
      "nothing is ever deleted",
      function* () {
        yield* Db.rows(list);

        return true;
      },
      { at: "end" },
    );

    const incomplete = await Explore.run({
      ...explorationOf("incomplete", approvedEditor),
      rules: [savedMeansCommitted, neverAtEnd],
      depth: 2,
      budget: 6,
    }).then(
      () => undefined,
      (error: ExploreIncomplete) => error,
    );

    expect(incomplete).toBeInstanceOf(ExploreIncomplete);
    expect(incomplete?.message).toContain("stopped at the budget before 2 move(s)");

    const allowed = await Explore.run({
      ...explorationOf("incomplete allowed", approvedEditor),
      depth: 2,
      budget: 6,
      allow: { truncated: true },
    });

    expect(allowed.checked.complete).toBe(false);
  }, 300_000);

  it("f(real clock) → refused: timing would decide what happens", async () => {
    const refused = await Explore.run({
      ...explorationOf("real clock", approvedEditor),
      story: story.with({ clock: "real" }),
    }).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(refused?.message).toContain("needs the story's manual clock");
  });
});
