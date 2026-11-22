/**
 * Explorations of stories: what can happen (`Explore.source`, and sources adapters make, such as
 * `Form.typing`), tried in every order up to a depth, deterministically, on a story runner from
 * `@highalch/story`, with its rules (`Story.rule`) checked at their moments. A failure is shrunk,
 * confirmed and replayed with everything captured. Shards split one exploration across processes
 * (`HIGHALCH_SHARD=2/4`), and each streams what it runs with `@highalch/stream` when
 * `HIGHALCH_STREAM_URL` is set.
 *
 * ```ts
 * import { Explore } from "@highalch/explore";
 * ```
 */
export { Explore, ExploreFailure, ExploreFlaky, ExploreIncomplete } from "./explore";

export type {
  Declared,
  Explored,
  Generated,
  Generation,
  Origin,
  Running,
  Stories,
  Walks,
} from "./explore";
