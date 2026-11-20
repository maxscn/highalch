/**
 * Screens for stories: a story mounts a real React component against its own client. Piped with
 * frames, it captures a frame after every later step (painted by takumi's WASM renderer, no
 * browser), compared with reviewed baselines pixel by pixel and reported as a filmstrip; piped
 * with a layout engine, rules read its layout. Steps for the same runner as `@highalch/story`.
 * This entry needs `react-dom` and `happy-dom` (optional peer dependencies of the package); no
 * other entry imports them.
 *
 * ```ts
 * import { Screen } from "@highalch/story/screen";
 * import { Takumi } from "@highalch/story/takumi";
 *
 * const List = Screen.make({ css, width: 360, height: 200 }).pipe(
 *   Takumi.frames({ baselines, output }), // frames, when the story needs them
 *   Takumi.layout(), // a layout for rules, when a rule reads it
 * );
 * // in a story: List.render(<NoteList account="acc-1" />), …, List.shot("saved")
 * ```
 */
import { overflowing } from "./layout";
import { compare, decode, encode } from "./png";
import { frames, layout, make } from "./screen";

/**
 * Screens: `make(options)` and the pipe steps that give one an engine (`frames(painter, settings)`,
 * `layout(engine)`; a painter entry has its own, `Takumi.frames` and `Takumi.layout`),
 * `overflowing(layout)` (what spills out of its box on a screen's layout), and the PNG helpers.
 */
export const Screen = { make, frames, layout, overflowing, compare, decode, encode } as const;

export type { Frame, Framed, Frames, Laid, Options, Place, Status, Viewport } from "./screen";

export { PainterOf } from "./painter";

export type { Painter, Painting } from "./painter";

export { Layout, LayoutOf } from "./layout";

export type { Box, Extent, Layouter, Measured, Overflow, Run } from "./layout";

export type { Difference, Pixels } from "./png";
