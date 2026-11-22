/**
 * The stream explorations send while they run, for an app to show them live (one tile per
 * sequence, every shard's in one grid), and the client that sends it.
 *
 * A process streams when `HIGHALCH_STREAM_URL` is set (with `HIGHALCH_STREAM_TOKEN`, or
 * `HIGHALCH_STREAM_AUTH=github-oidc`); tests change nothing. The receiving app decodes what it
 * receives with these schemas:
 *
 * ```ts
 * import { Envelope, Open } from "@highalch/story/stream";
 * import { Schema } from "effect";
 *
 * const open = Schema.decodeUnknownSync(Open)(await request.json());
 * const envelopes = text.split("\n").filter(Boolean).map((line) =>
 *   Schema.decodeUnknownSync(Envelope)(JSON.parse(line)),
 * );
 * ```
 */
export {
  Attempt,
  Ended,
  Envelope,
  Event,
  Failure,
  Finished,
  Frame,
  Kind,
  Open,
  Opened,
  Origin,
  Phase,
  Ran,
  Shard,
  Started,
  version,
} from "./protocol";
export { checkedUrl, connect, fromEnv, shardOf } from "./sink";
export type { Auth, Frames, Settings, Sink } from "./sink";
