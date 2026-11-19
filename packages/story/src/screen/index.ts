/**
 * Screens for stories: a story mounts a real React component against its own client and captures
 * a frame after every later step, painted by takumi's WASM renderer (no browser), compared with
 * reviewed baselines pixel by pixel, and reported as a filmstrip. Steps for the same runner as
 * `@highalch/story`. This entry needs `react-dom`, `happy-dom` and `takumi-js` (optional
 * peer dependencies of the package); no other entry imports them.
 *
 * ```ts
 * import * as Viewport from "@highalch/story/screen";
 *
 * const Screen = Viewport.make({ css, width: 360, height: 200, baselines, output });
 * // in a story: Screen.render(<NoteList account="acc-1" />), …, Screen.shot("saved")
 * ```
 */
export { make } from "./screen";

export type { Frame, Options, Place, Screen, Status } from "./screen";

export { compare, decode, encode } from "./png";

export type { Difference, Pixels } from "./png";
