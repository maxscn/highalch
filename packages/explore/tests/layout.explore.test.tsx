import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Explore, ExploreFailure } from "@highalch/explore";
import { Screen } from "@highalch/story/screen";
import { Takumi } from "@highalch/story/takumi";
import { Form } from "@highalch/story/tanstack-form";
import { Db } from "@highalch/story/tanstack-db";
import { OverflowingTitle, Shared } from "@highalch/examples";

const { ApprovedNoteCard, BrokenNoteCard, titleForm, css } = OverflowingTitle;
const { ada, exist, list, story } = Shared;

/** The card's screen lays it out for the rule; no story here compares a frame. */
const Card = Screen.make({ css, width: 360, height: 240 }).pipe(Takumi.layout());

const longest = "W".repeat(60);

/** The rule the broken card breaks: judged on the screen's layout, not its pixels. */
const fits = Story.rule("nothing on screen spills out of its box", function* () {
  const layout = yield* Card.layout();

  return Screen.overflowing(layout).length === 0;
});

const explorationOf = (name: string, view: React.JSX.Element) => ({
  name,
  story,
  setup: [exist(ada), Db.open(list), Card.render(view)],
  sources: [
    // No values of ours: the schema's boundary (the longest title) and seeded samples.
    Form.typing(titleForm, { fields: ["title"] }),
    Explore.source("submit", { step: () => Form.submit(titleForm) }),
    Explore.source("settle", { step: () => Story.settle() }),
  ],
  rules: [...Db.rules, fits],
  depth: 3,
  artifacts: new URL("../artifacts/explore/", import.meta.url),
});

describe("f(Form.typing, a layout rule) → overflow explored", () => {
  it("f(the title field's schema) → its longest value first, then seeded samples", () => {
    const values = Form.typing(titleForm, { fields: ["title"] }).values;

    expect(values).toHaveLength(4);
    expect(values[0]).toEqual({ field: "title", instance: 0, value: longest });
  });

  it("f(approved card) → every sequence keeps the layout rule", async () => {
    const explored = await Explore.run(
      explorationOf("approved card", <ApprovedNoteCard NoteId="n1" title="Ada" />),
    );

    // 6 moves (4 values, submit, settle): 6 + 36 + 216 sequences.
    expect(explored.checked).toEqual({ sequences: 258, depth: 3, complete: true });
  }, 300_000);

  it("f(broken card) → shrunk to typing the longest title and submitting", async () => {
    const failure = await Explore.run(
      explorationOf("broken card", <BrokenNoteCard NoteId="n1" title="Ada" />),
    ).then(
      () => undefined,
      (error: ExploreFailure) => error,
    );

    expect(failure).toBeInstanceOf(ExploreFailure);
    expect(failure?.sequence).toEqual([
      `typing.step({"field":"title","instance":0,"value":"${longest}"})`,
      "submit.step()",
    ]);
    expect(failure?.message).toContain("h1.title: text");
  }, 300_000);
});
