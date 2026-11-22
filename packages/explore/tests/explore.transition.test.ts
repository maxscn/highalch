import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import {
  Explore,
  ExploreFailure,
  ExploreFlaky,
  ExploreIncomplete,
  type Generation,
} from "@highalch/explore";
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
const savedMeansCommitted = Story.rule(
  "an editor says Saved only after its save committed",
  function* () {
    const editor = yield* Machine.snapshot();

    if (!editor?.matches("Saved")) return true;

    const commands = yield* Db.commands();

    return ["Committed", "Unconfirmed"].includes(commands.at(-1)?.outcome ?? "");
  },
  { at: "rest" },
);

const artifacts = new URL("../artifacts/explore/", import.meta.url);

/** An editor's stories: its runner (named, with the rules), setup, sources, up to 3 moves. */
const storiesOf = (
  name: string,
  machine: typeof approvedEditor,
  more: Partial<Generation> = {},
  rules: ReadonlyArray<Story.Rule> = [...Db.rules, savedMeansCommitted],
) =>
  Explore.stories(story.with({ name, rules }), {
    setup: [
      Story.given(n1, new NoteCreated({ note: ada })),
      Db.open(list),
      Machine.start(machine, { input: { NoteId: "n1" } }),
    ],
    sources: [edit, save, settle, remote],
    depth: 3,
    ...more,
  });

describe("f(runner, sources) → stories, each a story of its own", () => {
  it("f(approved editor) → a story per sequence of up to 3 moves, named by its moves, runnable alone", async () => {
    const stories = storiesOf("approved editor", approvedEditor);
    const third = stories.at(6);

    // 5 moves: 5 + 25 + 125 stories, the shortest first.
    expect(stories.size).toBe(155);
    expect([...stories].map((each) => each.index)).toEqual([...Array(155).keys()]);
    expect(third?.name).toBe('edit "Ada 2", edit "locked"');
    expect(third?.moves).toEqual(['edit.step("Ada 2")', 'edit.step("locked")']);
    expect(third?.origin).toEqual({ kind: "checked" });
    expect(third?.code).toBe(
      ["await story(", "  ...setup,", '  edit.step("Ada 2"),', '  edit.step("locked"),', ");"].join(
        "\n",
      ),
    );
    expect(third?.prompt()).toContain(
      "Write a story an exploration generated as a hand-written story.",
    );
    expect(third?.prompt()).toMatch(
      /made in packages\/explore\/tests\/explore\.transition\.test\.ts:\d+/,
    );

    // A generated story runs like a hand-written one, its rules checked.
    await third?.();
  }, 300_000);
});

describe("f(stories) → every one run, a broken rule shrunk and replayed", () => {
  it("f(approved editor) → every story keeps the rules", async () => {
    const explored = await Explore.run(storiesOf("approved editor", approvedEditor), {
      artifacts,
    });

    expect(explored.checked).toEqual({ sequences: 155, depth: 3, complete: true });
    expect(explored.judged["an editor says Saved only after its save committed"]).toBeGreaterThan(
      0,
    );
    expect(explored.report).toContain(
      "Checked: every one of the 155 sequence(s) of up to 3 move(s)",
    );
  }, 300_000);

  it("f(broken editor) → the shortest failing story: runnable, as code, and a prompt to pin it", async () => {
    const failure = await Explore.run(storiesOf("broken editor", brokenEditor), {
      artifacts,
    }).then(
      () => undefined,
      (error: ExploreFailure) => error,
    );

    expect(failure).toBeInstanceOf(ExploreFailure);
    expect(failure?.sequence).toEqual(['edit.step("locked")', "save.step()", "settle.step()"]);
    expect(failure?.message).toContain(
      '"an editor says Saved only after its save committed" does not hold',
    );
    expect(failure?.message).toContain('    edit.step("locked"),');
    expect(failure?.story.name).toBe('edit "locked", save, settle');

    // The failing story, run alone, fails as the exploration's did.
    const again = await failure?.story().then(
      () => undefined,
      (error: Error) => error,
    );

    expect(again?.message).toContain(
      '"an editor says Saved only after its save committed" does not hold',
    );

    const prompt = failure?.prompt ?? "";

    expect(prompt).toContain("Add a story that reproduces an exploration's failure");
    expect(prompt).toMatch(/made in packages\/explore\/tests\/explore\.transition\.test\.ts:\d+/);
    // The story to add, as the exploration's test writes it.
    expect(prompt).toContain(
      (failure?.code ?? "?")
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
    expect(prompt).toContain(failure?.failure.reason ?? "?");
    expect(prompt).toContain("packages/explore/artifacts/explore/broken-editor/trace.txt");
    expect(readFileSync(failure?.trace.replace(/trace\.txt$/, "prompt.md") ?? "", "utf8")).toBe(
      `${prompt}\n`,
    );

    const trace = readFileSync(failure?.trace ?? "", "utf8");

    expect(existsSync(failure?.trace ?? "")).toBe(true);
    expect(trace).toContain('machine editor (running): "Saved"');
    expect(trace).toContain("command editor: rename: Rejected");
  }, 300_000);

  it("f(sample) → walks from a fixed seed, reported with it", async () => {
    const walked = await Explore.run(
      storiesOf("walks", approvedEditor, { depth: 1, sample: { count: 5, length: 6, seed: 7 } }),
      { artifacts },
    );

    expect(walked.sampled).toEqual({ sequences: 5, seed: 7 });
    expect(walked.report).toContain("Sampled: 5 walk(s) (seed 7)");
  }, 300_000);
});

describe("f(exploration) → useful, not random", () => {
  it("f(discover, corpus) → a found failure is kept, and every later run replays it first", async () => {
    const corpus = new URL("../artifacts/explore-corpus/", import.meta.url);
    const file = new URL("broken-editor-discovered.explore.txt", corpus);

    await rm(file, { force: true });

    const first = await Explore.run(
      storiesOf("broken editor discovered", brokenEditor, {
        depth: 1,
        // A fixed seed so the test repeats; without one, each run would look somewhere new.
        discover: { count: 200, length: 6, seed: 3 },
        corpus,
      }),
      { artifacts },
    ).then(
      () => undefined,
      (error: ExploreFailure) => error,
    );

    expect(first?.message).toMatch(/found in a discovered walk \(seed \d+\)/);
    expect(first?.message).toContain("added to the corpus");
    // One line: typing "locked", saving, then anything that lets the reply arrive.
    expect(readFileSync(file, "utf8")).toMatch(
      /^\[\["edit","locked"\],\["save",null\],\["\w+",null\]\]\n$/,
    );

    // Without discovering: deterministic, and the corpus's story comes first.
    const kept = storiesOf("broken editor discovered", brokenEditor, { depth: 1, corpus });

    expect(kept.at(0)?.origin).toEqual({ kind: "corpus" });

    const again = await Explore.run(kept, { artifacts }).then(
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

          // Fails the first time only: the shrunk story's replays pass.
          if (calls === 1) throw new Error("heads");
        }),
    });

    const failure = await Explore.run(
      storiesOf("flaky", approvedEditor, { sources: [coin], depth: 1 }),
      { artifacts },
    ).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(ExploreFlaky);
    expect(failure?.message).toContain("did not fail the same way on replay 1");
  }, 300_000);

  it("f(rule never judged, budget hit) → ExploreIncomplete, unless allowed", async () => {
    const neverAtEnd = Story.rule(
      "nothing is ever deleted",
      function* () {
        yield* Db.rows(list);

        return true;
      },
      { at: "end" },
    );

    const incomplete = await Explore.run(
      storiesOf("incomplete", approvedEditor, { depth: 2, budget: 6 }, [
        savedMeansCommitted,
        neverAtEnd,
      ]),
      { artifacts },
    ).then(
      () => undefined,
      (error: ExploreIncomplete) => error,
    );

    expect(incomplete).toBeInstanceOf(ExploreIncomplete);
    expect(incomplete?.message).toContain("stopped at the budget before 2 move(s)");

    const allowed = await Explore.run(
      storiesOf("incomplete allowed", approvedEditor, { depth: 2, budget: 6 }),
      { artifacts, allow: { truncated: true } },
    );

    expect(allowed.checked.complete).toBe(false);
  }, 300_000);

  it("f(real clock, no name) → refused: timing would decide what happens; nothing names it", () => {
    expect(() =>
      Explore.stories(story.with({ name: "real clock", clock: "real" }), { sources: [edit] }),
    ).toThrow("needs the story's manual clock");
    expect(() => Explore.stories(story, { sources: [edit] })).toThrow("needs a named runner");
  });
});
