/**
 * Bugs a story catches, each a broken and an approved variant of a view, machine or form, and
 * the shared runner they run on. Tests and other packages' tests use them as fixtures:
 * `import { SwallowedRejection } from "@highalch/examples"`.
 */
export * as EmptyWhileLoading from "./empty-while-loading";
export * as ResetOnSubmit from "./reset-on-submit";
export * as Shared from "./shared";
export * as StickyOptimistic from "./sticky-optimistic";
export * as SwallowedRejection from "./swallowed-rejection";
