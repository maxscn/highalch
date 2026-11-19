/**
 * Machine steps for stories: XState machines over `HighAlch` commands, in the same story runner as
 * the data steps (`Story.make`). A machine enters a story stepped purely (`Machine.given`: every
 * step is XState's pure `transition`, nothing runs, hostless stories included) or running
 * (`Machine.start`: an actor against the story's client); `when`, `then` and `asked` read the same
 * in both. `explore` generates stories from a model. `invoke`, `mark` and `Runner` are
 * re-exported from `@highalch/db/xstate`, where production machines import them. This entry
 * needs `xstate` and `@xstate/effect` (optional peer dependencies of the package).
 *
 * ```ts
 * import { explore, Machine } from "@highalch/story/xstate";
 * ```
 */
export { commandOf, invoke, mark, Runner } from "@highalch/db/xstate";

export type { Invocable, Marked } from "@highalch/db/xstate";

export { Machine } from "./machine";

export type { Addressed, Expected, FromShown, Named, Read, Snapshot } from "./machine";

export { explore, pathsOf } from "./explore";

export type { Explored, Exploration, Path } from "./explore";
