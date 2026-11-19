/**
 * XState machines over `HighAlch` commands: `invoke(command)` is the actor logic a machine
 * invokes a command with (its output the `Settled` value, its error the typed rejection, read with `rejection`), marked
 * with its command so a story can see what a machine asked for. Production machines import it
 * from here; `@highalch/story/xstate` re-exports it for tests. This entry needs `xstate` and
 * `@xstate/effect` (optional peer dependencies of the package).
 *
 * ```ts
 * import { invoke } from "@highalch/db/xstate";
 * ```
 */
export { commandOf, invoke, mark, rejection, Runner } from "./invoke";

export type { Invocable, Marked } from "./invoke";
