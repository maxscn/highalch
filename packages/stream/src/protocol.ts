import { Schema } from "effect";

/**
 * The stream an exploration sends while it runs, so an app can show it live: every sequence it
 * tries (a tile), each step of it, the frame its screen showed, and how each ended. Shards of one
 * exploration (CI jobs that split its sequences) send to the same run and exploration, so the
 * app can lay every shard's tiles out in one grid.
 *
 * Over HTTP, the receiving app implements four endpoints under the stream's URL:
 *
 * - `POST /v1/sessions`: `Authorization: Bearer <ingest token>` (or a GitHub OIDC token, with
 *   `HighAlch-Auth: github-oidc`), body `Open`; answers `201` with `Opened`. The ingest token is
 *   sent here only: everything after uses the session's own token.
 * - `POST /v1/sessions/:session/events`: `Authorization: Bearer <session token>`, body
 *   `application/x-ndjson`, one `Envelope` per line; answers `204`. A batch may be sent again
 *   after a failure: `seq` is unique per session, so the app keeps the first of each.
 * - `PUT /v1/sessions/:session/frames/:sha256`: the session's token, body `image/png`; answers
 *   `204`. Frames are named by the SHA-256 of their bytes (lower-case hex), which the app checks,
 *   and sent before the first event that names them; a frame already sent is not sent again.
 * - `POST /v1/sessions/:session/close`: the session's token; answers `204`. A session that
 *   closes no more takes events; a process that dies leaves it open, so treat a long-idle one as
 *   ended.
 *
 * A `401` or `403` turns the stream off for the rest of the process; it never fails a test.
 */
export const version = 1 as const;

/** A shard of an exploration: the `index`-th (from 1) of `total` that split its sequences. */
export const Shard = Schema.Struct({ index: Schema.Int, total: Schema.Int });
export type Shard = typeof Shard.Type;

/** Where a run comes from: the repository, commit and CI run, as far as they are known. */
export const Origin = Schema.Struct({
  repository: Schema.optionalKey(Schema.String),
  commit: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  pullRequest: Schema.optionalKey(Schema.Int),
  ci: Schema.optionalKey(
    Schema.Struct({
      provider: Schema.String,
      run: Schema.String,
      attempt: Schema.optionalKey(Schema.String),
      job: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type Origin = typeof Origin.Type;

/**
 * What a process asks to stream: the run it belongs to (every shard of a CI run names the same
 * one), which shard it is, where the run comes from, and the kit's protocol.
 */
export const Open = Schema.Struct({
  protocol: Schema.Literal(version),
  run: Schema.String,
  shard: Shard,
  origin: Origin,
});
export type Open = typeof Open.Type;

/**
 * The app's answer: the session's id and its own token, valid until `expires` (ISO 8601) and
 * for this session's events and frames only.
 */
export const Opened = Schema.Struct({
  session: Schema.String,
  token: Schema.String,
  expires: Schema.String,
});
export type Opened = typeof Opened.Type;

/** A frame a step's screen showed: its PNG's SHA-256 (sent to `frames/`), and its size. */
export const Frame = Schema.Struct({
  image: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
});
export type Frame = typeof Frame.Type;

/** How a story run failed: the step (past the last one: at the end), why, and the detail. */
export const Failure = Schema.Struct({
  step: Schema.Int,
  reason: Schema.String,
  detail: Schema.Array(Schema.String),
});
export type Failure = typeof Failure.Type;

/**
 * Where a sequence comes from: the corpus (failures found before), every sequence up to the
 * exploration's depth (checked), fixed-seed walks (sampled), fresh-seed walks (discovered).
 */
export const Kind = Schema.Literals(["corpus", "checked", "sampled", "discovered"]);
export type Kind = typeof Kind.Type;

/**
 * Why a sequence runs: `explore` the first time; `shrink` with moves dropped from a failing one;
 * `confirm` replaying the shortest failure to check it fails the same way; `replay` once more,
 * capturing everything, for the report.
 */
export const Phase = Schema.Literals(["explore", "shrink", "confirm", "replay"]);
export type Phase = typeof Phase.Type;

/**
 * An exploration starts (in this shard): its sequences, numbered across every shard, so tiles
 * from all shards share one grid; and which of them this shard runs (`index % total` is
 * `shard.index - 1`).
 */
export const Started = Schema.Struct({
  type: Schema.Literal("exploration"),
  exploration: Schema.String,
  name: Schema.String,
  shard: Shard,
  sequences: Schema.Struct({
    total: Schema.Int,
    corpus: Schema.Int,
    checked: Schema.Int,
    sampled: Schema.Int,
    discovered: Schema.Int,
  }),
  depth: Schema.Int,
  sources: Schema.Array(Schema.Struct({ name: Schema.String, values: Schema.Int })),
  rules: Schema.Array(Schema.String),
  setup: Schema.Array(Schema.String),
});
export type Started = typeof Started.Type;

/**
 * A run of a sequence starts: an `attempt`, numbered in the session, of the sequence `sequence`
 * (its number in the grid), for a `phase`, with its moves as the story that replays them.
 */
export const Attempt = Schema.Struct({
  type: Schema.Literal("attempt"),
  exploration: Schema.String,
  attempt: Schema.Int,
  sequence: Schema.Int,
  kind: Kind,
  phase: Phase,
  moves: Schema.Array(Schema.String),
});
export type Attempt = typeof Attempt.Type;

/**
 * A step of an attempt ran: its number (the setup's steps first), its label, whether it passed,
 * and the frame its screen showed after it, when it has a screen and frames are streamed.
 */
export const Ran = Schema.Struct({
  type: Schema.Literal("step"),
  exploration: Schema.String,
  attempt: Schema.Int,
  step: Schema.Int,
  label: Schema.String,
  status: Schema.Literals(["passed", "failed"]),
  frame: Schema.optionalKey(Frame),
});
export type Ran = typeof Ran.Type;

/** An attempt ended: passed, or failed (a step, or a rule after one), in `ms`. */
export const Ended = Schema.Struct({
  type: Schema.Literal("attempt-end"),
  exploration: Schema.String,
  attempt: Schema.Int,
  status: Schema.Literals(["passed", "failed"]),
  failure: Schema.optionalKey(Failure),
  ms: Schema.Finite,
});
export type Ended = typeof Ended.Type;

/**
 * An exploration ended (in this shard): passed; failed, with the shortest failing sequence as a
 * story to paste; flaky (a failure that did not fail the same way again); or incomplete (it
 * checked less than it says). `judged` counts each rule's checks in this shard: a rule another
 * shard judged is judged.
 */
export const Finished = Schema.Struct({
  type: Schema.Literal("exploration-end"),
  exploration: Schema.String,
  status: Schema.Literals(["passed", "failed", "flaky", "incomplete"]),
  ran: Schema.Int,
  judged: Schema.Record(Schema.String, Schema.Int),
  failure: Schema.optionalKey(
    Schema.Struct({
      sequence: Schema.Int,
      moves: Schema.Array(Schema.String),
      reason: Schema.String,
      detail: Schema.Array(Schema.String),
      story: Schema.String,
    }),
  ),
  report: Schema.String,
});
export type Finished = typeof Finished.Type;

/** Anything an exploration streams. */
export const Event = Schema.Union([Started, Attempt, Ran, Ended, Finished]);
export type Event = typeof Event.Type;

/** An event as sent: its number in the session (from 1) and when (ms since the epoch). */
export const Envelope = Schema.Struct({ seq: Schema.Int, at: Schema.Finite, event: Event });
export type Envelope = typeof Envelope.Type;
