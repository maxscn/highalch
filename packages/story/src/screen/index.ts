/**
 * Screens for stories: a story mounts a real React component against its own client and captures
 * a frame after every later step, painted by takumi's WASM renderer (no browser), compared with
 * reviewed baselines pixel by pixel, and reported as a filmstrip. Steps for the same runner as
 * `@highalch/story`. A painter entry's Layer paints the frames (`@highalch/story/takumi`). This
 * entry needs `react-dom` and `happy-dom` (optional peer dependencies of the package); no other
 * entry imports them.
 *
 * ```ts
 * import { Screen } from "@highalch/story/screen";
 * import { Takumi } from "@highalch/story/takumi";
 *
 * const List = Screen.make({ css, width: 360, height: 200, baselines, output, painter: Takumi.layer() });
 * // in a story: List.render(<NoteList account="acc-1" />), …, List.shot("saved")
 * ```
 */
import { compare, decode, encode } from "./png";
import { make } from "./screen";

/** Screen steps (`Screen.make(options)` builds them for a component) and the PNG helpers. */
export const Screen = { make, compare, decode, encode } as const;

export type { Frame, Options, Place, Status, Viewport } from "./screen";

export { PainterOf } from "./painter";

export type { Painter, Painting } from "./painter";

export type { Difference, Pixels } from "./png";
