/**
 * takumi's WASM renderer as a screen's engines: it lays out and paints a frame's HTML and CSS
 * without a browser, the same binary on every platform. `Takumi.frames({ … })` gives a screen
 * frames; `Takumi.layout()` gives it the layout rules read (`Card.layout()`), from the same
 * engine, so what a rule judges is what the frames show. This entry needs `takumi-js` (an optional
 * peer dependency of the package); no other entry imports it.
 *
 * ```ts
 * import { Screen } from "@highalch/story/screen";
 * import { Takumi } from "@highalch/story/takumi";
 *
 * const Card = Screen.make({ css, width: 360, height: 240 }).pipe(
 *   Takumi.frames({ baselines, output }),
 *   Takumi.layout(),
 * );
 * ```
 */
import { readFile } from "node:fs/promises";
import { Layer, Option } from "effect";
import { render, type ContainerNode, type Font, type MeasuredNode, type Node } from "takumi-js";
import { fromHtml } from "takumi-js/helpers/html";
import { init, Renderer } from "takumi-js/wasm";
import wasm from "takumi-js/wasm-url";
import { LayoutOf, type Layouter, type Measured } from "../screen/layout";
import { PainterOf, type Painter } from "../screen/painter";
import { frames, layout, type Frames } from "../screen/screen";

/** The wasm renderer's module bytes, loaded once: the same renderer binary on every platform. */
let module: Promise<Uint8Array> | undefined;

const moduleOf = () => (module ??= readFile(wasm));

/** How takumi paints: the fonts it paints with (local bytes); its built-in font otherwise. */
export type Options = { readonly fonts?: ReadonlyArray<Font> };

/** A takumi painter: frames painted by its WASM renderer, baselines under `takumi/`. */
const painter = (options: Options = {}): Painter => ({
  name: "takumi",
  paint: async ({ html, css, width, height }) => {
    const data = await render(html, {
      module: await moduleOf(),
      width,
      height,
      css: [...css],
      fonts: options.fonts && [...options.fonts],
      format: "raw",
    });

    return { width, height, data };
  },
});

/** An element whose text is only whitespace (a title of `"\t"`): takumi lays out no box for it. */
const blank = (node: Node) => node.type === "text" && node.text.trim() === "";

/**
 * A node's children as takumi boxed them: all of them when there are as many boxes, else without
 * the blank ones it laid out no box for, when that leaves as many; otherwise none.
 */
const boxed = (children: ReadonlyArray<Node>, boxes: number): Option.Option<ReadonlyArray<Node>> =>
  Option.liftPredicate(children, (all) => all.length === boxes).pipe(
    Option.orElse(() =>
      Option.liftPredicate(
        children.filter((child) => !blank(child)),
        (laid) => laid.length === boxes,
      ),
    ),
  );

/**
 * takumi's boxes for the node tree it was given. A node's measured children are its children's
 * boxes when there are as many (blank elements aside); otherwise takumi made boxes of its own
 * (inline content wrapped among blocks, the text of an element laid out as a flex item, an
 * inline-block), which belong to no element: they keep no attributes, so the screen folds them
 * into the nearest element.
 */
const zip = (node: Option.Option<Node>, measured: MeasuredNode): Measured => {
  const [, , , , x, y] = measured.transform;
  const children = node.pipe(
    Option.filter((found): found is ContainerNode => found.type === "container"),
    Option.flatMap((container) => Option.fromUndefinedOr(container.children)),
    Option.getOrElse((): ReadonlyArray<Node> => []),
  );
  const paired = boxed(children, measured.children.length);

  return {
    attributes: Option.match(node, {
      onNone: () => ({}),
      onSome: (found) => found.attributes ?? {},
    }),
    x,
    y,
    width: measured.width,
    height: measured.height,
    runs: measured.runs,
    children: measured.children.map((box, index) =>
      zip(
        Option.flatMap(paired, (laid) => Option.fromUndefinedOr(laid[index])),
        box,
      ),
    ),
  };
};

/** The WASM module instantiated once for measuring (painting instantiates it through `render`). */
let ready: Promise<unknown> | undefined;

/** A takumi layout engine: boxes measured by the same renderer that paints the frames. */
const layouter = (options: Options = {}): Layouter => ({
  name: "takumi",
  measure: async ({ html, css, width, height }) => {
    await (ready ??= moduleOf().then((bytes) => init({ module_or_path: bytes })));

    const renderer = new Renderer();

    try {
      await Promise.all((options.fonts ?? []).map((font) => renderer.registerFont(font)));

      const { node } = fromHtml(html);

      return zip(Option.some(node), await renderer.measure(node, { width, height, css: [...css] }));
    } finally {
      renderer.free();
    }
  },
});

/**
 * takumi's engines as a screen's pipe steps: `Takumi.frames({ baselines, output, update?,
 * fonts? })` paints its frames (baselines under `takumi/`), `Takumi.layout({ fonts? })` lays it
 * out for rules. Give a screen only what its stories use.
 */
export const Takumi = {
  frames: (settings: Frames & Options) =>
    frames(Layer.succeed(PainterOf, painter(settings)), settings),
  layout: (options: Options = {}) => layout(Layer.succeed(LayoutOf, layouter(options))),
} as const;

export type { Font };
