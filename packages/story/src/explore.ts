import { Option } from "effect";
import { pathOf, slug, type Place } from "./files";
import { before, rule, type Rule } from "./rules";
import { StoryFailure, type Story } from "./run";
import { flatten, type Step, type Steps } from "./steps";
import { json } from "./world";

/**
 * Something that can happen in an exploration: a name, the values it is tried with, and the step
 * each value makes. `step(value)` makes the same step a story writes by hand, so a failing
 * sequence pastes as a story: `edit.step("locked")`.
 */
export type Source<V = void> = {
  readonly name: string;
  readonly values: ReadonlyArray<V>;
  readonly step: (value: V) => Steps;
};

/** Any source, whatever its values: what an exploration's `sources` hold. */
export type AnySource = {
  readonly name: string;
  readonly values: ReadonlyArray<unknown>;
  readonly step: (value: never) => Steps;
};

/** How `Explore.source` declares a source: its values (none: it takes no value) and its step. */
export type Declared<V> = {
  readonly values?: ReadonlyArray<V>;
  readonly step: (value: V) => Steps;
};

/** A source: `Explore.source("edit", { values: ["Ada 2", "locked"], step: (title) => … })`. */
export const source = <V = void>(name: string, declared: Declared<V>): Source<V> => ({
  name,
  // SAFETY: a source without values takes none: it is tried once, with `undefined`.
  values: declared.values ?? [undefined as V],
  step: declared.step,
});

/** One move of a sequence: a source and the value it is tried with. */
type Move = { readonly source: AnySource; readonly value: unknown };

/** A move as the story that replays it writes it: `edit.step("locked")`. */
const codeOf = (move: Move) =>
  Option.match(Option.fromUndefinedOr(move.value), {
    onNone: () => `${move.source.name}.step()`,
    onSome: (value) => `${move.source.name}.step(${json(value)})`,
  });

/** What an exploration runs: the story, what can happen, the rules, and how far it looks. */
export type Exploration = {
  /** The name of the exploration: its replay and artifacts are named by it. */
  readonly name: string;
  /** The story runner each sequence runs on (a fresh world per sequence). */
  readonly story: Story;
  /** Steps before every sequence (history, a mounted screen, a running machine). */
  readonly setup?: Steps;
  /** What can happen: every sequence is made of their moves. */
  readonly sources: ReadonlyArray<AnySource>;
  /** Checked at their moments on every sequence. */
  readonly rules: ReadonlyArray<Rule>;
  /** Every sequence of up to this many moves runs (default 2). */
  readonly depth?: number;
  /** At most this many sequences run, in their deterministic order (default 2 000). */
  readonly budget?: number;
  /**
   * Longer sequences after the short ones: `count` walks of up to `length` moves picked at
   * random from `seed`; the same seed picks the same walks (default: none).
   */
  readonly walks?: { readonly count: number; readonly length?: number; readonly seed?: number };
  /** Where a failure's replay writes its trace and frames (default `artifacts/explore`). */
  readonly artifacts?: Place;
};

/** What an exploration ran. */
export type Explored = {
  readonly sequences: number;
  readonly walks: number;
  /** Whether it stopped at its budget before every sequence of `depth` moves ran. */
  readonly truncated: boolean;
};

/** Every move of the sources, in their order. */
const movesOf = (sources: ReadonlyArray<AnySource>): ReadonlyArray<Move> =>
  sources.flatMap((each) => each.values.map((value) => ({ source: each, value })));

/** Every sequence of 1 to `depth` moves, shortest first, at most `budget`. */
const sequencesOf = (moves: ReadonlyArray<Move>, depth: number, budget: number) => {
  const found: Array<ReadonlyArray<Move>> = [];
  let layer: ReadonlyArray<ReadonlyArray<Move>> = [[]];

  for (let length = 1; length <= depth; length += 1) {
    const next: Array<ReadonlyArray<Move>> = [];

    for (const prefix of layer)
      for (const move of moves) {
        if (found.length + next.length >= budget)
          return { found: [...found, ...next], truncated: true };

        next.push([...prefix, move]);
      }

    found.push(...next);
    layer = next;
  }

  return { found, truncated: false };
};

/** A seeded random number generator (mulberry32): the same seed, the same walks. */
const random = (seed: number) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** `count` walks of 1 to `length` moves picked at random from `seed`. */
const walksOf = (moves: ReadonlyArray<Move>, count: number, length: number, seed: number) => {
  const next = random(seed);

  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(next() * length) }, () => {
      // SAFETY: an index below the moves' length.
      return moves[Math.floor(next() * moves.length)] as Move;
    }),
  );
};

/** The steps of a sequence: the setup, then each move's. */
const stepsOf = (exploration: Exploration, sequence: ReadonlyArray<Move>): ReadonlyArray<Step> =>
  flatten([
    exploration.setup ?? [],
    ...// SAFETY: each move's value is one of its own source's values.
    sequence.map((move) => move.source.step(move.value as never)),
  ]);

/** What a failure is about, so a shorter sequence counts as the same failure. */
const aboutOf = (failure: StoryFailure) => failure.reason.replace(/step \d+ \([^)]*\)/gi, "step");

/** Runs one sequence quietly (nothing captured); its failure, if any. */
const attempt = async (exploration: Exploration, sequence: ReadonlyArray<Move>) => {
  try {
    await exploration.story.with({
      rules: exploration.rules,
      capture: "off",
      trace: false,
      name: exploration.name,
    })(stepsOf(exploration, sequence));

    return Option.none<StoryFailure>();
  } catch (error) {
    if (!(error instanceof StoryFailure)) throw error;

    return Option.some(error);
  }
};

/** Drops moves from a failing sequence while it still fails the same way. */
const shrink = async (
  exploration: Exploration,
  sequence: ReadonlyArray<Move>,
  failure: StoryFailure,
) => {
  const about = aboutOf(failure);
  let best = { sequence, failure };
  let changed = true;

  while (changed) {
    changed = false;

    for (const index of best.sequence.keys()) {
      const shorter = best.sequence.filter((_, position) => position !== index);
      const result = await attempt(exploration, shorter);

      if (Option.isSome(result) && aboutOf(result.value) === about) {
        best = { sequence: shorter, failure: result.value };
        changed = true;
        break;
      }
    }
  }

  return best;
};

/** A failing sequence as a story to paste into a test. */
const pasteable = (sequence: ReadonlyArray<Move>) =>
  [
    "story.with({ rules })(",
    "  ...setup,",
    ...sequence.map((move) => `  ${codeOf(move)},`),
    ");",
  ].join("\n");

/** An exploration found a sequence that breaks a rule (or a step). */
export class ExploreFailure extends Error {
  override readonly name = "ExploreFailure";

  constructor(
    message: string,
    readonly sequence: ReadonlyArray<string>,
    readonly failure: StoryFailure,
    readonly trace: string,
  ) {
    super(message, { cause: failure });
  }
}

/**
 * Explores what can happen: runs every sequence of up to `depth` moves of the sources (then the
 * seeded walks), each as a fresh story after `setup`, checking the rules at their moments, and
 * capturing nothing. When a sequence fails, it is shrunk to the shortest that fails the same
 * way and replayed once with everything captured: a text trace and the screens' frames under
 * `artifacts`. The failure lists the sequence as a story to paste into a test. Runs are
 * deterministic (the story's manual clock and wire, seeded walks), so the replay reproduces it.
 */
export const run = async (exploration: Exploration): Promise<Explored> => {
  const moves = movesOf(exploration.sources);
  const { found, truncated } = sequencesOf(
    moves,
    exploration.depth ?? 2,
    exploration.budget ?? 2_000,
  );

  const walks = Option.match(Option.fromUndefinedOr(exploration.walks), {
    onNone: () => [],
    onSome: (walks) => walksOf(moves, walks.count, walks.length ?? 12, walks.seed ?? 1),
  });

  const all = [...found, ...walks];

  for (const [index, sequence] of all.entries()) {
    const result = await attempt(exploration, sequence);

    if (Option.isNone(result)) continue;

    const shortest = await shrink(exploration, sequence, result.value);
    const name = `${exploration.name} (explored)`;
    const folder = `${pathOf(exploration.artifacts ?? "artifacts/explore")}/${slug(exploration.name)}`;
    const trace = `${folder}/trace.txt`;

    // The replay captures everything; it fails as the sequence did.
    await exploration.story
      .with({ rules: exploration.rules, capture: "record", traceTo: trace, name })(
        stepsOf(exploration, shortest.sequence),
      )
      .catch(() => undefined);

    throw new ExploreFailure(
      [
        `Explore "${exploration.name}": ${shortest.failure.reason}`,
        `  found in sequence ${index + 1} of ${all.length}, shrunk from ${sequence.length} to ${shortest.sequence.length} move(s):`,
        ...shortest.sequence.map((move, at) => `    ${at + 1}. ${codeOf(move)}`),
        ...shortest.failure.detail.map((line) => `  ${line}`),
        "  as a story:",
        ...pasteable(shortest.sequence)
          .split("\n")
          .map((line) => `    ${line}`),
        `  replayed with everything captured: ${trace} (and the screens' frames under their output)`,
      ].join("\n"),
      shortest.sequence.map(codeOf),
      shortest.failure,
      trace,
    );
  }

  return { sequences: found.length, walks: walks.length, truncated };
};

/**
 * Rules and explorations: `Explore.rule(sentence, function* () { … }, { at })` declares what must
 * hold, reading what it yields (`yield* Db.rows(list)`; `yield* Explore.before(reader)` for its
 * value at the previous check), checked by stories (`story.with({ rules })`) and explorations
 * alike; `Explore.source` declares what can happen; `Explore.run` explores every sequence of it.
 */
export const Explore = { rule, before, source, run } as const;
