import { Context } from "effect";
import type { Pixels } from "./png";

/** What a screen paints for one frame: its serialised markup, stylesheets and viewport. */
export type Painting = {
  /** The mounted DOM, serialised with current control values, inside a viewport-sized root. */
  readonly html: string;
  readonly css: ReadonlyArray<string>;
  readonly width: number;
  readonly height: number;
};

/**
 * How a screen's frames are painted: takumi's WASM renderer (`@highalch/story/takumi`), a real
 * browser, or any other renderer of HTML and CSS. `name` keeps each painter's baselines apart
 * (`<baselines>/<name>/<story>/…`), since engines paint the same markup differently.
 */
export type Painter = {
  readonly name: string;
  readonly paint: (painting: Painting) => Promise<Pixels>;
};

/** The painter a screen paints with, as a service: a painter entry's Layer provides it. */
export class PainterOf extends Context.Service<PainterOf, Painter>()(
  "@highalch/story/screen/Painter",
) {}
