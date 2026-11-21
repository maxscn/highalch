/**
 * takumi's WASM renderer as a screen painter: it lays out and paints a frame's HTML and CSS
 * without a browser, the same binary on every platform. This entry needs `takumi-js` (an
 * optional peer dependency of the package); no other entry imports it.
 *
 * ```ts
 * import { Screen } from "@highalch/story/screen";
 * import { Takumi } from "@highalch/story/takumi";
 *
 * const List = Screen.make({ css, width: 360, height: 200, baselines, output, painter: Takumi.layer() });
 * ```
 */
import { readFile } from "node:fs/promises";
import { Layer } from "effect";
import { render, type Font } from "takumi-js";
import wasm from "takumi-js/wasm-url";
import { PainterOf, type Painter } from "../screen/painter";

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

/** takumi as a screen painter: `Takumi.layer({ fonts? })` is what `Screen.make` takes. */
export const Takumi = {
  layer: (options: Options = {}) => Layer.succeed(PainterOf, painter(options)),
} as const;

export type { Font };
