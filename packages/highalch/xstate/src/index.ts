/**
 * Machine steps for stories: XState machines over `LowAlch` commands, in the same story runner as
 * the data steps (`Story.make`). A machine enters a story stepped purely (`Machine.given`: every
 * step is XState's pure `transition`, nothing runs, hostless stories included) or running
 * (`Machine.start`: an actor against the story's client); `when`, `then` and `asked` read the same
 * in both. `invoke`, `mark` and `Runner` are
 * re-exported from `@lowalch/tanstack-db/xstate`, where production machines import them. This entry
 * needs `xstate` and `@xstate/effect` (optional peer dependencies of the package).
 *
 * ```ts
 * import { Machine } from "@highalch/xstate";
 * ```
 */
export { commandOf, invoke, mark, rejection, Runner } from "@lowalch/tanstack-db/xstate";

export type { Invocable, Marked } from "@lowalch/tanstack-db/xstate";

export { Machine } from "./machine";

export type { Addressed, Atoms, Expected, FromShown, Named, Read, Snapshot } from "./machine";
