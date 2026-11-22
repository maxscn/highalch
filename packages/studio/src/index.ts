/**
 * The HighAlch studio, on this machine: a relay that receives what explorations stream (as the
 * console would) and passes it to the page at https://highalch.studio, which connects to it from
 * the browser. Nothing leaves this machine, and nothing runs on a server of ours.
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
