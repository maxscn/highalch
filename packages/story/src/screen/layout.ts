import { Context } from "effect";
import type { Painting } from "./painter";

/** A run of text as an engine laid it out. */
export type Run = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * A box as an engine laid it out: its border box in viewport pixels, the text runs it lays out
 * (relative to its content box), its child boxes, and the attributes of the element it is the
 * box of (the screen finds the element by its `data-box`). A box the engine made for no element
 * (the text of an element laid out as a flex item, inline content wrapped among blocks) has none.
 */
export type Measured = {
  readonly attributes: Readonly<Record<string, string>>;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly runs: ReadonlyArray<Run>;
  readonly children: ReadonlyArray<Measured>;
};

/**
 * How a screen's layout is measured: takumi's layout engine (`Takumi.layout()` from
 * `@highalch/story/takumi`), a real browser, or any engine that lays out HTML and CSS. Separate
 * from the painter, so a screen can paint with one engine and judge its layout with another.
 */
export type Layouter = {
  readonly name: string;
  readonly measure: (painting: Painting) => Promise<Measured>;
};

/** The engine a screen measures its layout with, as a service: a layout entry's Layer. */
export class LayoutOf extends Context.Service<LayoutOf, Layouter>()(
  "@highalch/story/screen/Layout",
) {}

/** A rectangle in viewport pixels. */
export type Extent = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * One laid-out element: its name, its border box, the box its content may fill (its padding
 * box), whether it clips what overflows it, and what it lays out, in viewport pixels.
 */
export type Box = Extent & {
  /** The element as a path of tags and classes from the screen: `section.card > h1.title`. */
  readonly element: string;
  /** Where its content may reach without overflowing: its border box less its borders. */
  readonly inner: Extent;
  /** Whether the element hides (or scrolls) what overflows it on each axis: its `overflow`. */
  readonly clips: { readonly x: boolean; readonly y: boolean };
  /** Its text, its inline content's and its anonymous boxes'. */
  readonly runs: ReadonlyArray<Run>;
  /** Boxes the engine made for no element, with no text of their own (an inline-block's). */
  readonly anonymous: ReadonlyArray<Extent>;
  readonly children: ReadonlyArray<Box>;
};

/** Something that spills out of its box: an element's text or content, or a child element. */
export type Overflow = {
  /** The element whose box is overflowed. */
  readonly element: string;
  /** What overflows it: its text (`text "Ada"`), a child element, or its inline content. */
  readonly what: string;
  readonly side: "left" | "right" | "top" | "bottom";
  /** By how many pixels, rounded. */
  readonly by: number;
};

/** Sub-pixel differences engines round differently. */
const tolerance = 0.5;

const snippet = (text: string) => {
  if (text.length <= 12) return `text "${text}"`;

  return `text "${text.slice(0, 12)}…" (${text.length} characters)`;
};

const spills = (box: Box, inner: Extent): ReadonlyArray<Pick<Overflow, "side" | "by">> => {
  const outer = box.inner;
  const sides = [
    { side: "left" as const, by: outer.x - inner.x, clipped: box.clips.x },
    {
      side: "right" as const,
      by: inner.x + inner.width - (outer.x + outer.width),
      clipped: box.clips.x,
    },
    { side: "top" as const, by: outer.y - inner.y, clipped: box.clips.y },
    {
      side: "bottom" as const,
      by: inner.y + inner.height - (outer.y + outer.height),
      clipped: box.clips.y,
    },
  ];

  return sides
    .filter(({ by, clipped }) => !clipped && by > tolerance)
    .map(({ side, by }) => ({ side, by: Math.round(by) }));
};

/**
 * What spills out of its box on a laid-out screen: an element's text running past its padding
 * box, or a child element (or an inline box) reaching past it, unless that element clips
 * (`overflow: hidden`, `clip`, `auto` or `scroll`; a form control scrolls its own text). The
 * screen itself scrolls down, so only what runs off its sides counts there. Empty when
 * everything fits, or when nothing is rendered yet.
 */
export const overflowing = (layout: Layout | undefined): ReadonlyArray<Overflow> => {
  if (layout === undefined) return [];

  const walk = (box: Box): ReadonlyArray<Overflow> => [
    ...box.runs.flatMap((run) =>
      spills(box, run).map((spill) => ({
        element: box.element,
        what: snippet(run.text),
        ...spill,
      })),
    ),
    ...box.anonymous.flatMap((extent) =>
      spills(box, extent).map((spill) => ({
        element: box.element,
        what: "an inline box",
        ...spill,
      })),
    ),
    ...box.children.flatMap((child) =>
      spills(box, child).map((spill) => ({ element: box.element, what: child.element, ...spill })),
    ),
    ...box.children.flatMap(walk),
  ];

  return walk(layout.root);
};

/** How an overflow reads in a failure: `h1.title: text "WWWW…" runs 788px past its right edge`. */
const describe = (overflow: Overflow) =>
  `${overflow.element}: ${overflow.what} runs ${overflow.by}px past its ${overflow.side} edge`;

/**
 * A screen's layout as a rule reads it (`reads: { layout: List.layout() }`): every element's box.
 * It prints as what overflows, so a failing rule's report stays readable.
 */
export class Layout {
  constructor(
    readonly engine: string,
    readonly root: Box,
  ) {}

  toJSON() {
    return {
      engine: this.engine,
      screen: `${this.root.width}×${this.root.height}`,
      overflowing: overflowing(this).map(describe),
    };
  }
}
