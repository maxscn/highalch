/**
 * The HighAlch studio serves a local viewer for streamed explorations.
 *
 * ```sh
 * highalch studio -- vp test                  # one process
 * highalch studio --concurrency 4 -- vp test  # four shards of one run
 * ```
 *
 * `relay()` starts one from code (a test, a custom runner).
 */
export { relay, studio as page } from "./relay";

export type { Options, Relay } from "./relay";

export { parse, studio } from "./cli";

export type { Asked, Io } from "./cli";
