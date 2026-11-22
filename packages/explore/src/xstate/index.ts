/**
 * Stories generated from a model: a small XState machine models what can happen to an entity,
 * `explore` runs every path through it (XState's own graph traversal) as a story on a runner
 * from `@highalch/story`, with its rules checked, and shrinks a failing path. This entry needs
 * `xstate` (an optional peer dependency of the package).
 *
 * ```ts
 * import { explore } from "@highalch/explore/xstate";
 * ```
 */
export { explore, pathsOf } from "./explore";

export type { Explored, Exploration, Path } from "./explore";
