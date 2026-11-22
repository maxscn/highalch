import { Schema } from "effect";

/**
 * `story.json` (`highalch.story/1`): what a HighAlch story run reports, one per story run,
 * passed or failed. Every step, what every adapter showed after it, the rules judged at each
 * moment, the frames, and what every source showed over the whole story. Plain JSON: `Redacted` values read `"<redacted>"`, typed errors and states are
 * `{ _tag, ...fields }`. Imports only `effect`, so the web app decodes reports with it too.
 *
 * HighAlch Console's own copy of the format: story reports are not in `@highalch/story` yet. Once
 * they land there, this module goes and the Console decodes with HighAlch's own schema
 * (`@highalch/story/report`). Keep the two identical until then.
 */

/** A count, a step number or an index. */
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Wall time in milliseconds: the one field that differs between two identical runs. */
const Millis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** At most this many rows of a source in a step's world; histories and feeds are whole. */
export const maxRows = 200;

/** The test a story ran in, as `@highalch/story/vitest`'s `withTest` fills it. */
export const Test = Schema.Struct({ file: Schema.String, name: Schema.String });

export type Test = typeof Test.Type;

/** A typed value (an error, a read state): its `_tag` and its fields as JSON. */
export const Tagged = Schema.StructWithRest(Schema.Struct({ _tag: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json),
]);

export type Tagged = typeof Tagged.Type;

/** When a rule is checked: after every step, at rest, or at the end. */
export const At = Schema.Literals(["step", "rest", "end"]);

/** A rule a story keeps: its sentence and when it is checked. */
export const RuleReport = Schema.Struct({ name: Schema.String, at: At });

/**
 * A rule judged at one moment (after a step, or at the end): whether it held and, when it did not,
 * what it read (the lines its failure shows).
 */
export const RuleResult = Schema.Struct({
  name: Schema.String,
  at: At,
  held: Schema.Boolean,
  read: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type RuleResult = typeof RuleResult.Type;

/** A row a source shows: its key, its fields and whether a local write is pending on it. */
export const Row = Schema.Struct({
  key: Schema.String,
  row: Schema.Json,
  pending: Schema.Boolean,
});

/** One source a client observes, after a step: its read state and its rows (at most `maxRows`). */
export const Source = Schema.Struct({
  /** The collection's id. */
  id: Schema.String,
  scope: Schema.String,
  /** Its read state as the app's views read it: `Loading`, `Ready`, `Missing`, a typed error, … */
  state: Tagged,
  /** How many rows it shows. */
  count: Count,
  rows: Schema.Array(Row),
  /** Whether rows were left out (more than `maxRows`). */
  truncated: Schema.Boolean,
});

export type Source = typeof Source.Type;

/** How a command ended, so far. */
export const Outcome = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Committed", { value: Schema.optionalKey(Schema.Json) }),
  Schema.TaggedStruct("Unconfirmed", { value: Schema.Json }),
  Schema.TaggedStruct("Rejected", { error: Tagged }),
  Schema.TaggedStruct("Died", { message: Schema.String }),
]);

export type Outcome = typeof Outcome.Type;

/** A command one of the story's clients ran: a step's, a machine's or the app's own. */
export const Command = Schema.Struct({
  label: Schema.String,
  scope: Schema.String,
  /** What ran it: `story`, `machine:<name>` or `app`. */
  by: Schema.String,
  /** The key of the row it addresses (empty for none). */
  key: Schema.String,
  /** The id it was sent with, which the feed's entries name. */
  commandId: Schema.String,
  input: Schema.Json,
  /** The step that ran it. */
  step: Count,
  outcome: Outcome,
});

export type Command = typeof Command.Type;

/** A command a machine asked for. */
export const Asked = Schema.Struct({ command: Schema.String, input: Schema.Json });

/** A machine of the story, after a step. */
export const Machine = Schema.Struct({
  name: Schema.String,
  mode: Schema.Literals(["stepped", "running"]),
  /** Whether a mounted component reads it through its atoms. */
  mounted: Schema.Boolean,
  state: Schema.Json,
  context: Schema.Json,
  /** What it asked for since its last event. */
  asked: Schema.Array(Asked),
});

export type Machine = typeof Machine.Type;

/** One client's connection to the Domain: its feed, what is in flight and what it sent and asked. */
export const Wire = Schema.Struct({
  scope: Schema.String,
  feed: Schema.Literals(["live", "dropped", "muted"]),
  /** Requests running now. */
  inflight: Count,
  /** Replies and answers held at the wire now. */
  held: Count,
  /** Commands sent so far. */
  sent: Count,
  /** Queries asked so far, by name, in order. */
  asked: Schema.Array(Schema.String),
});

export type Wire = typeof Wire.Type;

/** The world after a step (or as it was when the step failed). Each adapter fills its part. */
export const World = Schema.Struct({
  /** Whether the hosted server had nothing queued. */
  server: Schema.optionalKey(Schema.Struct({ idle: Schema.Boolean })),
  wires: Schema.optionalKey(Schema.Array(Wire)),
  /** The data steps' sources (`@highalch/story/tanstack-db`). */
  sources: Schema.optionalKey(Schema.Array(Source)),
  /** The data steps' commands. */
  commands: Schema.optionalKey(Schema.Array(Command)),
  /** The machine steps' machines (`@highalch/story/xstate`). */
  machines: Schema.optionalKey(Schema.Array(Machine)),
});

export type World = typeof World.Type;

/** How a frame compared with its baseline (`recorded`: an exploration's replay, not compared). */
export const FrameStatus = Schema.Literals([
  "matched",
  "created",
  "updated",
  "missing",
  "mismatch",
  "recorded",
]);

/** A frame a screen captured at a step, in the story's folder beside `story.json`. */
export const Frame = Schema.Struct({
  /** The PNG's file name. */
  file: Schema.String,
  status: FrameStatus,
  /** The PNG's SHA-256, hex. */
  sha256: Schema.String,
  /** Pixels that differ from the baseline (a mismatch). */
  differing: Schema.optionalKey(Count),
  /** The baseline's copy and the diff, beside the frame (a mismatch). */
  expected: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
});

export type Frame = typeof Frame.Type;

/** One step of a story, whether it ran or not. */
export const Step = Schema.Struct({
  /** Its number, from 1. */
  n: Count,
  /** Its kind: the step's `_tag`, the verb of its label (`When`, `Rejected`, `Render`, …). */
  kind: Schema.String,
  label: Schema.String,
  status: Schema.Literals(["passed", "failed", "not-run"]),
  durationMs: Schema.optionalKey(Millis),
  /** The story clock after it, in ms. */
  clock: Schema.optionalKey(Schema.Number),
  /** Whether the story was at rest after it. */
  rest: Schema.optionalKey(Schema.Boolean),
  /** The world after it; absent when it did not run. */
  world: Schema.optionalKey(World),
  frame: Schema.optionalKey(Frame),
  /** The rules judged after it, in order (a rule that does not hold is the last). */
  rules: Schema.Array(RuleResult),
});

export type Step = typeof Step.Type;

/** One change a source showed: the row of a key after it (none: it left). */
export const Shown = Schema.Struct({
  tick: Count,
  step: Count,
  key: Schema.String,
  row: Schema.optionalKey(Schema.Json),
  pending: Schema.optionalKey(Schema.Boolean),
  removed: Schema.optionalKey(Schema.Literal(true)),
});

/** What one source showed over the whole story, in order. */
export const History = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  shown: Schema.Array(Shown),
});

export type History = typeof History.Type;

/** One entry of a feed: the row of an entity's key after a command (none: removed). */
export const Entry = Schema.Struct({
  seq: Count,
  commandId: Schema.String,
  entity: Schema.String,
  key: Schema.String,
  row: Schema.optionalKey(Schema.Json),
  removed: Schema.optionalKey(Schema.Literal(true)),
});

/** The feed entries a scope's client reads, over the whole story (`@highalch/story/lowalch`). */
export const Feed = Schema.Struct({ scope: Schema.String, entries: Schema.Array(Entry) });

export type Feed = typeof Feed.Type;

/** Where an exploration's sequence came from. */
export const Level = Schema.Literals(["corpus", "checked", "sampled", "discovered"]);

/** An exploration's failing sequence, as its replay's `story.json` names it. */
export const Explored = Schema.Struct({
  /** The exploration's name. */
  name: Schema.String,
  level: Level,
  /** The seed of a sampled or discovered walk. */
  seed: Schema.optionalKey(Schema.Number),
  /** Its number among the exploration's sequences (from 1), of `of`. */
  index: Count,
  of: Count,
  /** The moves replayed (shrunk), as a story writes them: `edit.step("locked")`. */
  moves: Schema.Array(Schema.String),
  /** The moves of the sequence as found, before shrinking. */
  shrunkFrom: Schema.Array(Schema.String),
});

/** `story.json`: one story run, every step, the world after each, what every source showed. */
export const StoryReport = Schema.Struct({
  format: Schema.Literal("highalch.story/1"),
  name: Schema.String,
  /** Its folder: `<folder>/<slug>/story.json`, beside its screen's frames. */
  slug: Schema.String,
  test: Schema.optionalKey(Test),
  status: Schema.Literals(["passed", "failed"]),
  durationMs: Millis,
  host: Schema.Literals(["memory", "custom", "none"]),
  /** The story's first scope (hosted stories). */
  scope: Schema.optionalKey(Schema.String),
  clock: Schema.optionalKey(Schema.Literals(["manual", "real"])),
  /** The rules the story keeps. */
  rules: Schema.Array(RuleReport),
  /** A failed story's failure: the step, why, and what was expected and observed. */
  failure: Schema.optionalKey(
    Schema.Struct({ step: Count, reason: Schema.String, detail: Schema.Array(Schema.String) }),
  ),
  steps: Schema.Array(Step),
  /** The end of the story: the rules judged once it ran its course. Absent when it did not get there. */
  end: Schema.optionalKey(Schema.Struct({ rules: Schema.Array(RuleResult) })),
  histories: Schema.Array(History),
  feeds: Schema.Array(Feed),
  /** An exploration's replay: the failing sequence it replays. */
  explore: Schema.optionalKey(Explored),
});

export type StoryReport = typeof StoryReport.Type;
