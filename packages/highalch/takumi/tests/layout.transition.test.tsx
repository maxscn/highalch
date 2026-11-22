import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Screen, type Overflow } from "@highalch/screen";
import { Takumi } from "@highalch/takumi";
import { Form } from "@highalch/tanstack-form";
import { Db } from "@highalch/tanstack-db";
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

const typed = (name: string, view: React.JSX.Element) =>
  story.with({ name, rules: [...Db.rules, fits] })(
    exist(ada),
    Db.open(list),
    Card.render(view),
    Form.when(titleForm, "title", longest),
    Form.submit(titleForm),
    Story.settle(),
  );

/** What a static view's layout reports, read through a rule that keeps it. */
const overflowOf = async (name: string, view: React.JSX.Element, sheet: string) => {
  const Static = Screen.make({ css: sheet, width: 360, height: 240 }).pipe(Takumi.layout());
  let seen: ReadonlyArray<Overflow> = [];

  await story.with({
    name,
    rules: [
      Story.rule("keeps what overflows", function* () {
        seen = Screen.overflowing(yield* Static.layout());

        return true;
      }),
    ],
  })(Static.render(view));

  return seen.map(({ element, what, side, by }) => `${element}: ${what} ${side} ${by}`);
};

describe("f(screen, layout engine) → every element's box, and what spills out of it", () => {
  it("f(padding, inline content, clipping, a blank element) → nothing; f(a long word, a wide child) → each, named", async () => {
    const sheet = `
      .box { display: block; width: 200px; margin: 0; }
      .padded { padding: 10px 40px; border: 4px solid #000; }
      .clip { overflow: hidden; }
      .wide { display: block; width: 260px; height: 10px; }
    `;

    expect(
      await overflowOf(
        "layout fits",
        <main>
          <p className="box padded">Short words that wrap inside the padding of their box</p>
          <p className="box">
            Hello <b>bold</b> and <span>inline</span> text
          </p>
          <p className="box clip">{"W".repeat(40)}</p>
        </main>,
        sheet,
      ),
    ).toEqual([]);

    // takumi lays out no box for an element of whitespace (a title of "\t"): its siblings are
    // still matched to theirs, so the clipping one still clips.
    expect(
      await overflowOf(
        "layout blank",
        <main>
          <h1>{"\t"}</h1>
          <p className="box clip">{"W".repeat(40)}</p>
        </main>,
        sheet,
      ),
    ).toEqual([]);

    expect(
      await overflowOf(
        "layout overflows",
        <main>
          <p className="box padded">{"W".repeat(20)}</p>
          <div className="box">
            <span className="wide" />
          </div>
        </main>,
        sheet,
      ),
    ).toEqual([
      // takumi sizes boxes by their border box: the text starts at 4 + 40 and is 299px wide, its
      // box's padding box ends at 200 - 4.
      'main > p.box.padded: text "WWWWWWWWWWWW…" (20 characters) right 147',
      "main > div.box: main > div.box > span.wide right 60",
    ]);
  });

  it("f(broken card, the longest title) → the heading's text runs past its right edge", async () => {
    const failure = await typed(
      "broken card typed",
      <BrokenNoteCard NoteId="n1" title="Ada" />,
    ).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    // The title shows optimistically once submitted, so the rule breaks at the submit.
    expect(failure?.step).toBe(5);
    expect(failure?.message).toContain('"nothing on screen spills out of its box" does not hold');
    expect(failure?.message).toMatch(
      /main\.page > section\.card > h1\.title: text \\"WWWWWWWWWWWW…\\" \(60 characters\) runs \d+px past its right edge/,
    );
  });

  it("f(approved card, the longest title) → the heading wraps; the input clips its own text", () =>
    typed("approved card typed", <ApprovedNoteCard NoteId="n1" title="Ada" />));

  it("f(a screen without a layout engine, or without frames) → no reader, no shot", () => {
    const Bare = Screen.make({ css, width: 360, height: 240 });

    // @ts-expect-error a screen piped no layout engine has no layout to read
    expect(Bare.layout).toBeUndefined();
    // @ts-expect-error a screen piped no frames has no shot
    expect(Bare.shot).toBeUndefined();
    expect(Card.layout).toBeTypeOf("function");
  });
});
