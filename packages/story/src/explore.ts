import { Option, Predicate } from "effect";
import { pathOf, readText, slug, write, type Place } from "./files";
import { before, rule, type Rule } from "./rules";
import { StoryFailure, type Observer, type Story } from "./run";
import type { Kind, Phase, Shard } from "./stream/protocol";
import { shardOf, streamed, type Sink } from "./stream/sink";
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

/** These lines when `condition` holds; none otherwise. */
const onlyIf = <A>(condition: boolean, lines: () => ReadonlyArray<A>): ReadonlyArray<A> => {
  if (condition) return lines();

  return [];
};

/** One move of a sequence: a source and the value it is tried with. */
type Move = { readonly source: AnySource; readonly value: unknown };

/** A move as the story that replays it writes it: `edit.step("locked")`. */
const codeOf = (move: Move) =>
  Option.match(Option.fromUndefinedOr(move.value), {
    onNone: () => `${move.source.name}.step()`,
    onSome: (value) => `${move.source.name}.step(${json(value)})`,
  });

/** Random walks: how many, of up to how many moves. */
export type Walks = { readonly count: number; readonly length?: number };

/** What an exploration runs: the story, what can happen, the rules, and how far it looks. */
export type Exploration = {
  /** The name of the exploration: its corpus, replay and artifacts are named by it. */
  readonly name: string;
  /** The story runner each sequence runs on (a fresh world per sequence; its clock manual). */
  readonly story: Story;
  /** Steps before every sequence (history, a mounted screen, a running machine). */
  readonly setup?: Steps;
  /** What can happen: every sequence is made of their moves. */
  readonly sources: ReadonlyArray<AnySource>;
  /** Checked at their moments on every sequence. */
  readonly rules: ReadonlyArray<Rule>;
  /** Checked: every sequence of up to this many moves runs (default 2). */
  readonly depth?: number;
  /** At most this many checked sequences run, in their order (default 2 000). */
  readonly budget?: number;
  /**
   * Sampled: longer sequences picked at random from a fixed `seed` (default 1), the same on every
   * run. Deterministic, like the checked ones.
   */
  readonly sample?: Walks & { readonly seed?: number };
  /**
   * Discovery: walks from a fresh seed on this run (printed in the report), to find cases the
   * fixed sequences do not. Not repeatable by design: keep it out of CI (`discover: false`, the
   * default). A failing sequence it finds is added to the corpus, so every later run replays it.
   * `seed` reruns a discovery run whose report printed it.
   */
  readonly discover?: boolean | (Walks & { readonly seed?: number });
  /**
   * Where the corpus is kept: `<corpus>/<name>.explore.txt`, one failing sequence per line,
   * committed with the tests. Every run replays it first.
   */
  readonly corpus?: Place;
  /** Where a failure's replay writes its trace and frames (default `artifacts/explore`). */
  readonly artifacts?: Place;
  /**
   * Which shard of the exploration this process runs (`{ index: 2, total: 4 }`, the 2nd of 4;
   * `HIGHALCH_SHARD=2/4` by default): every shard numbers the sequences the same way and runs
   * every `total`-th, so shards on separate machines cover them all once. A shard leaves the
   * check that every rule was judged to the shards together (the stream counts each shard's).
   */
  readonly shard?: Shard;
  /**
   * Where the exploration streams its sequences as they run (`@highalch/story/stream`): the
   * process's stream from `HIGHALCH_STREAM_URL` by default, or none (`false`).
   */
  readonly stream?: Sink | false;
  /** What a run may leave undone and still pass. */
  readonly allow?: {
    /** Pass when the checked sequences stop at the budget before `depth`. */
    readonly truncated?: boolean;
    /** Rules (by name) that may never be judged: a rule nothing reached otherwise fails. */
    readonly unjudged?: ReadonlyArray<string>;
  };
};

/** What an exploration covered. */
export type Explored = {
  /** Every sequence of up to `depth` moves (`complete` unless the budget stopped it). */
  readonly checked: {
    readonly sequences: number;
    readonly depth: number;
    readonly complete: boolean;
  };
  /** The fixed-seed walks. */
  readonly sampled: { readonly sequences: number; readonly seed: number };
  /** The corpus's sequences, replayed first. */
  readonly corpus: number;
  /** The fresh-seed walks, when discovering. */
  readonly discovered: Option.Option<{ readonly sequences: number; readonly seed: number }>;
  /** How many times each rule was judged, by name. */
  readonly judged: Readonly<Record<string, number>>;
  /** The shard that ran (`1` of `1` unsharded): it ran every `total`-th sequence. */
  readonly shard: Shard;
  /** How many sequences this shard ran. */
  readonly ran: number;
  /** The coverage as text: what is checked, sampled, replayed and discovered. */
  readonly report: string;
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
const walksOf = (moves: ReadonlyArray<Move>, walks: Walks, seed: number) => {
  const next = random(seed);
  const length = walks.length ?? 12;

  return Array.from({ length: walks.count }, () =>
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
    // SAFETY: each move's value is one of its own source's values.
    ...sequence.map((move) => move.source.step(move.value as never)),
  ]);

/** What a failure is about, so a shorter sequence counts as the same failure. */
const aboutOf = (failure: StoryFailure) =>
  failure.reason.replace(/step \d+ \([^)]*\)/gi, "step").replace(/ at line \d+/g, "");

/** Whether a failure is the world not settling (a timing limit, not a broken rule). */
const unsettled = (failure: StoryFailure) => failure.reason.includes("did not settle");

/** An exploration's rules, counting how often each is judged. */
const counting = (rules: ReadonlyArray<Rule>, judged: Record<string, number>) =>
  rules.map((each): Rule => ({
    ...each,
    check: async (stage, moment) => {
      judged[each.name] = (judged[each.name] ?? 0) + 1;

      return each.check(stage, moment);
    },
  }));

/** Where an attempt is streamed: the stream, the exploration's id, and its tile. */
type Tile = {
  readonly sink: Option.Option<Sink>;
  readonly exploration: string;
  /** The sequence's number across every shard. */
  readonly sequence: number;
  readonly kind: Kind;
  readonly phase: Phase;
};

/** Attempts in this process, numbered once across its explorations: the session's numbering. */
let attempts = 0;

/** What a failed story run says, as the stream carries it. */
const failureOf = (failure: StoryFailure) => ({
  step: failure.step,
  reason: failure.reason,
  detail: [...failure.detail],
});

/**
 * Streams a story run of a sequence as an attempt of its tile: when it starts, each step (with
 * its screen's frame, when frames are streamed), and how it ended. Without a stream, nothing.
 */
const streaming = async <A>(
  tile: Tile,
  sequence: ReadonlyArray<Move>,
  run: (observe: Option.Option<Observer>) => Promise<A>,
): Promise<A> => {
  if (Option.isNone(tile.sink)) return run(Option.none());

  const sink = tile.sink.value;
  const exploration = tile.exploration;

  attempts += 1;

  const attempt = attempts;
  const started = performance.now();

  sink.send({
    type: "attempt",
    exploration,
    attempt,
    sequence: tile.sequence,
    kind: tile.kind,
    phase: tile.phase,
    moves: sequence.map(codeOf),
  });

  const observe: Observer = {
    frames: sink.frames === "every" || (sink.frames === "replay" && tile.phase === "replay"),
    step: async ({ step, label, status, frame }) => {
      const image = await Option.match(frame, {
        onNone: async () => Option.none<string>(),
        onSome: (shown) => sink.frame(shown.png),
      });

      sink.send({
        type: "step",
        exploration,
        attempt,
        step,
        label,
        status,
        ...Option.match(
          Option.zipWith(image, frame, (sha, shown) => ({ sha, shown })),
          {
            onNone: () => ({}),
            onSome: ({ sha, shown }) => ({
              frame: { image: sha, width: shown.width, height: shown.height },
            }),
          },
        ),
      });
    },
  };

  const ended = (failure: Option.Option<StoryFailure>) =>
    sink.send({
      type: "attempt-end",
      exploration,
      attempt,
      ...Option.match(failure, {
        onNone: () => ({ status: "passed" as const }),
        onSome: (failed) => ({ status: "failed" as const, failure: failureOf(failed) }),
      }),
      ms: Math.round(performance.now() - started),
    });

  try {
    const result = await run(Option.some(observe));

    ended(Option.none());

    return result;
  } catch (error) {
    if (error instanceof StoryFailure) ended(Option.some(error));

    throw error;
  }
};

/**
 * Runs one sequence quietly (nothing captured, unless its tile streams frames); its failure, if
 * any. A world that did not settle is tried once more: only one that never settles fails, as such.
 */
const attempt = async (
  exploration: Exploration,
  rules: ReadonlyArray<Rule>,
  sequence: ReadonlyArray<Move>,
  tile: Tile,
  again = true,
): Promise<Option.Option<StoryFailure>> => {
  try {
    await streaming(tile, sequence, (observe) =>
      exploration.story.with({
        rules,
        capture: "off",
        trace: false,
        name: exploration.name,
        ...Option.match(observe, { onNone: () => ({}), onSome: (each) => ({ observe: each }) }),
      })(stepsOf(exploration, sequence)),
    );

    return Option.none();
  } catch (error) {
    if (!(error instanceof StoryFailure)) throw error;

    if (again && unsettled(error)) return attempt(exploration, rules, sequence, tile, false);

    return Option.some(error);
  }
};

/** Drops moves from a failing sequence while it still fails the same way. */
const shrink = async (
  exploration: Exploration,
  rules: ReadonlyArray<Rule>,
  sequence: ReadonlyArray<Move>,
  failure: StoryFailure,
  tile: Tile,
) => {
  const about = aboutOf(failure);
  let best = { sequence, failure };
  let changed = true;

  while (changed) {
    changed = false;

    for (const index of best.sequence.keys()) {
      const shorter = best.sequence.filter((_, position) => position !== index);
      const result = await attempt(exploration, rules, shorter, { ...tile, phase: "shrink" });

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

/** A sequence as one corpus line: each move's source and value. */
const lineOf = (sequence: ReadonlyArray<Move>) =>
  json(sequence.map((move) => [move.source.name, move.value ?? null]));

/** The corpus file of an exploration, when it keeps one. */
const corpusFile = (exploration: Exploration) =>
  Option.map(
    Option.fromUndefinedOr(exploration.corpus),
    (place) => `${pathOf(place)}/${slug(exploration.name)}.explore.txt`,
  );

/** The corpus's sequences, by the sources' names; a name no source has fails the run. */
const corpusOf = async (exploration: Exploration): Promise<ReadonlyArray<ReadonlyArray<Move>>> => {
  const file = corpusFile(exploration);

  if (Option.isNone(file)) return [];

  const text = await readText(file.value);
  const lines = Option.getOrElse(text, () => "")
    .split("\n")
    .filter((line) => line.trim() !== "");

  return lines.map((line) => {
    const parsed: unknown = JSON.parse(line);

    if (!Array.isArray(parsed))
      throw new Error(`Explore corpus ${file.value}: not a sequence: ${line}`);

    return parsed.map((move: unknown): Move => {
      const [name, value] = Option.getOrElse(
        Option.liftPredicate(move, (each): each is ReadonlyArray<unknown> => Array.isArray(each)),
        (): ReadonlyArray<unknown> => [],
      );
      const found = exploration.sources.find((each) => each.name === name);

      if (!found)
        throw new Error(
          `Explore corpus ${file.value} names a source "${String(name)}" the exploration does not have`,
        );

      return { source: found, value: Option.getOrUndefined(Option.fromNullishOr(value)) };
    });
  });
};

/** Adds a failing sequence to the corpus (once). */
const remember = async (exploration: Exploration, sequence: ReadonlyArray<Move>) => {
  const file = corpusFile(exploration);

  if (Option.isNone(file)) return false;

  const known = Option.getOrElse(await readText(file.value), () => "");
  const line = lineOf(sequence);

  if (known.split("\n").includes(line)) return false;

  const separated = onlyIf(known !== "" && !known.endsWith("\n"), () => ["\n"]).join("");

  await write(file.value, `${known}${separated}${line}\n`);

  return true;
};

/** Where a sequence came from, as a failure names it. */
type Origin = {
  readonly kind: "corpus" | "checked" | "sampled" | "discovered";
  readonly seed?: number;
};

const originOf = (origin: Origin) =>
  Option.match(Option.fromUndefinedOr(origin.seed), {
    onNone: () => `a ${origin.kind} sequence`,
    onSome: (seed) => `a ${origin.kind} walk (seed ${seed})`,
  });

/** The checked sequences, as the report says them. */
const checkedOf = (checked: Explored["checked"]) => {
  if (checked.complete)
    return `every one of the ${checked.sequences} sequence(s) of up to ${checked.depth} move(s)`;

  return `the first ${checked.sequences} sequence(s) of up to ${checked.depth} move(s) (stopped at the budget)`;
};

/** The coverage as text. */
const reportOf = (exploration: Exploration, explored: Omit<Explored, "report">) =>
  [
    `Explore "${exploration.name}":`,
    ...onlyIf(explored.shard.total > 1, () => [
      `  Shard ${explored.shard.index} of ${explored.shard.total}: ran ${explored.ran} sequence(s), every ${explored.shard.total}th`,
    ]),
    `  Checked: ${checkedOf(explored.checked)}`,
    `  Sampled: ${explored.sampled.sequences} walk(s) (seed ${explored.sampled.seed})`,
    `  Corpus: ${explored.corpus} sequence(s) found before`,
    ...Option.match(explored.discovered, {
      onNone: () => [],
      onSome: (found) => [
        `  Discovered: ${found.sequences} walk(s) from a fresh seed (seed ${found.seed}; not repeatable)`,
      ],
    }),
    `  Rules: ${Object.entries(explored.judged)
      .map(([name, times]) => `"${name}" judged ${times} time(s)`)
      .join("; ")}`,
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
 * A failing sequence that does not fail the same way when replayed: the app or the kit is not
 * deterministic there. Reported, never retried away.
 */
export class ExploreFlaky extends Error {
  override readonly name = "ExploreFlaky";

  constructor(
    message: string,
    readonly sequence: ReadonlyArray<string>,
  ) {
    super(message);
  }
}

/** An exploration that left part of its check undone (a budget, a rule nothing reached). */
export class ExploreIncomplete extends Error {
  override readonly name = "ExploreIncomplete";

  constructor(
    message: string,
    readonly explored: Explored,
  ) {
    super(message);
  }
}

/** The exploration's shard: its own, else `HIGHALCH_SHARD`, else the only one. */
const shardIn = (exploration: Exploration): Shard => {
  const shard = Option.getOrElse(
    Option.orElse(Option.fromUndefinedOr(exploration.shard), () =>
      shardOf(globalThis.process?.env.HIGHALCH_SHARD || undefined),
    ),
    (): Shard => ({ index: 1, total: 1 }),
  );

  if (
    !Number.isInteger(shard.index) ||
    !Number.isInteger(shard.total) ||
    shard.index < 1 ||
    shard.index > shard.total
  )
    throw new Error(
      `Explore "${exploration.name}": shard ${shard.index} of ${shard.total} is not one of them: shards are numbered from 1 to their total`,
    );

  return shard;
};

/**
 * Explores what can happen, deterministically: the corpus's sequences first, then every sequence
 * of up to `depth` moves of the sources (checked), then fixed-seed walks (sampled), each a fresh
 * story after `setup` with the rules at their moments, capturing nothing. With `discover`, walks
 * from a fresh seed follow, to find what the fixed sequences do not. A failing sequence is shrunk
 * to the shortest that fails the same way, replayed twice more to confirm it fails the same way
 * (else `ExploreFlaky`), added to the corpus when discovered, and replayed once with everything
 * captured; the `ExploreFailure` lists it as a story to paste. A run that checked less than it
 * says (a budget hit, a rule never judged) fails as `ExploreIncomplete` unless `allow` names it.
 */
export const run = async (exploration: Exploration): Promise<Explored> => {
  const clock = Option.flatMap(exploration.story.options, (options) =>
    Option.fromUndefinedOr(options.clock),
  );

  if (Option.contains(clock, "real"))
    throw new Error(
      `Explore "${exploration.name}" needs the story's manual clock: with the real clock, timing decides what happens and a run is not repeatable`,
    );

  const judged: Record<string, number> = Object.fromEntries(
    exploration.rules.map((each) => [each.name, 0]),
  );

  const rules = counting(exploration.rules, judged);
  const moves = movesOf(exploration.sources);
  const depth = exploration.depth ?? 2;
  const { found, truncated } = sequencesOf(moves, depth, exploration.budget ?? 2_000);
  const sampleSeed = exploration.sample?.seed ?? 1;
  const sampled = Option.match(Option.fromUndefinedOr(exploration.sample), {
    onNone: () => [],
    onSome: (walks) => walksOf(moves, walks, sampleSeed),
  });

  const discovery = Option.map(
    Option.filter(Option.fromUndefinedOr(exploration.discover), (each) => each !== false),
    (each) => ({
      walks: Option.getOrElse(
        Option.liftPredicate(each, (given): given is Walks & { readonly seed?: number } =>
          Predicate.isObject(given),
        ),
        (): Walks & { readonly seed?: number } => ({ count: 200 }),
      ),
    }),
  );

  const discovering = Option.map(discovery, ({ walks }) => ({
    walks,
    // A fresh seed unless given: discovery is meant to look where the fixed runs do not.
    seed: walks.seed ?? Math.floor(Math.random() * 2_147_483_647),
  }));

  const discovered = Option.match(discovering, {
    onNone: () => [],
    onSome: ({ walks, seed }) => walksOf(moves, walks, seed),
  });

  const corpus = await corpusOf(exploration);

  const all: ReadonlyArray<{ readonly sequence: ReadonlyArray<Move>; readonly origin: Origin }> = [
    ...corpus.map((sequence) => ({ sequence, origin: { kind: "corpus" as const } })),
    ...found.map((sequence) => ({ sequence, origin: { kind: "checked" as const } })),
    ...sampled.map((sequence) => ({
      sequence,
      origin: { kind: "sampled" as const, seed: sampleSeed },
    })),
    ...Option.match(discovering, {
      onNone: () => [],
      onSome: ({ seed }) =>
        discovered.map((sequence) => ({ sequence, origin: { kind: "discovered" as const, seed } })),
    }),
  ];

  const shard = shardIn(exploration);
  const sink = Option.match(Option.fromUndefinedOr(exploration.stream), {
    onNone: streamed,
    onSome: (given) => Option.liftPredicate(given, (each): each is Sink => each !== false),
  });
  const id = slug(exploration.name);

  // Every shard numbers the sequences alike and runs every `total`-th.
  const mine = [...all.entries()].filter(([index]) => index % shard.total === shard.index - 1);
  let ran = 0;

  const covered = (): Omit<Explored, "report"> => ({
    checked: { sequences: found.length, depth, complete: !truncated },
    sampled: { sequences: sampled.length, seed: sampleSeed },
    corpus: corpus.length,
    discovered: Option.map(discovering, ({ seed }) => ({ sequences: discovered.length, seed })),
    judged: { ...judged },
    shard,
    ran,
  });

  /** Streams how the exploration ended in this shard, and waits until it is sent. */
  const finished = async (
    status: "passed" | "failed" | "flaky" | "incomplete",
    report: string,
    failure: Option.Option<{
      readonly sequence: number;
      readonly moves: ReadonlyArray<string>;
      readonly failure: StoryFailure;
      readonly story: string;
    }>,
  ) => {
    if (Option.isNone(sink)) return;

    sink.value.send({
      type: "exploration-end",
      exploration: id,
      status,
      ran,
      judged: { ...judged },
      ...Option.match(failure, {
        onNone: () => ({}),
        onSome: (failed) => ({
          failure: {
            sequence: failed.sequence,
            moves: [...failed.moves],
            reason: failed.failure.reason,
            detail: [...failed.failure.detail],
            story: failed.story,
          },
        }),
      }),
      report,
    });

    await sink.value.flush();
  };

  if (Option.isSome(sink))
    sink.value.send({
      type: "exploration",
      exploration: id,
      name: exploration.name,
      shard,
      sequences: {
        total: all.length,
        corpus: corpus.length,
        checked: found.length,
        sampled: sampled.length,
        discovered: discovered.length,
      },
      depth,
      sources: exploration.sources.map((each) => ({
        name: each.name,
        values: each.values.length,
      })),
      rules: exploration.rules.map((each) => each.name),
      setup: flatten([exploration.setup ?? []]).map((each) => each.label),
    });

  for (const [index, { sequence, origin }] of mine) {
    const tile: Tile = {
      sink,
      exploration: id,
      sequence: index,
      kind: origin.kind,
      phase: "explore",
    };
    const result = await attempt(exploration, rules, sequence, tile);

    ran += 1;

    if (Option.isNone(result)) continue;

    const shortest = await shrink(exploration, rules, sequence, result.value, tile);
    const codes = shortest.sequence.map(codeOf);

    // A failure must reproduce: replayed twice more, it fails the same way each time.
    for (const time of [1, 2]) {
      const replay = await attempt(exploration, rules, shortest.sequence, {
        ...tile,
        phase: "confirm",
      });
      const same = Option.exists(
        replay,
        (failure) => aboutOf(failure) === aboutOf(shortest.failure),
      );

      if (!same) {
        const message = [
          `Explore "${exploration.name}": a failing sequence did not fail the same way on replay ${time}: the app or the kit is not deterministic here`,
          ...codes.map((code, at) => `    ${at + 1}. ${code}`),
          `  first:  ${shortest.failure.reason}`,
          `  replay: ${Option.match(replay, { onNone: () => "passed", onSome: (failure) => failure.reason })}`,
        ].join("\n");

        await finished("flaky", message, Option.none());

        throw new ExploreFlaky(message, codes);
      }
    }

    const added = origin.kind === "discovered" && (await remember(exploration, shortest.sequence));
    const folder = `${pathOf(exploration.artifacts ?? "artifacts/explore")}/${slug(exploration.name)}`;
    const trace = `${folder}/trace.txt`;

    // The replay captures everything; it fails as the sequence did.
    await streaming({ ...tile, phase: "replay" }, shortest.sequence, (observe) =>
      exploration.story.with({
        rules,
        capture: "record",
        traceTo: trace,
        name: `${exploration.name} (explored)`,
        ...Option.match(observe, { onNone: () => ({}), onSome: (each) => ({ observe: each }) }),
      })(stepsOf(exploration, shortest.sequence)),
    ).catch(() => undefined);

    const message = [
      `Explore "${exploration.name}": ${shortest.failure.reason}`,
      `  found in ${originOf(origin)} (${index + 1} of ${all.length}), shrunk from ${sequence.length} to ${shortest.sequence.length} move(s), failing the same way on 2 replays:`,
      ...codes.map((code, at) => `    ${at + 1}. ${code}`),
      ...shortest.failure.detail.map((line) => `  ${line}`),
      "  as a story:",
      ...pasteable(shortest.sequence)
        .split("\n")
        .map((line) => `    ${line}`),
      ...onlyIf(added, () => [
        `  added to the corpus: ${Option.getOrElse(corpusFile(exploration), () => "")}`,
      ]),
      `  replayed with everything captured: ${trace} (and the screens' frames under their output)`,
      reportOf(exploration, covered()),
    ].join("\n");

    await finished(
      "failed",
      reportOf(exploration, covered()),
      Option.some({
        sequence: index,
        moves: codes,
        failure: shortest.failure,
        story: pasteable(shortest.sequence),
      }),
    );

    throw new ExploreFailure(message, codes, shortest.failure, trace);
  }

  const explored = covered();
  const report = reportOf(exploration, explored);
  // A shard judges only its share: whether every rule was judged is for the shards together.
  const unjudged = Object.entries(explored.judged).flatMap(([name, times]) =>
    onlyIf(
      shard.total === 1 && times === 0 && !(exploration.allow?.unjudged ?? []).includes(name),
      () => [name],
    ),
  );

  const undone = [
    ...onlyIf(truncated && !exploration.allow?.truncated, () => [
      `the checked sequences stopped at the budget before ${depth} move(s) (allow: { truncated: true } to accept it)`,
    ]),
    ...unjudged.map(
      (name) =>
        `"${name}" was never judged: no sequence reached a moment it is checked at (allow: { unjudged: [${json(name)}] } to accept it)`,
    ),
  ];

  if (undone.length > 0) {
    const message = [
      `Explore "${exploration.name}" left part of its check undone:`,
      ...undone.map((line) => `  ${line}`),
      report,
    ].join("\n");

    await finished("incomplete", message, Option.none());

    throw new ExploreIncomplete(message, { ...explored, report });
  }

  await finished("passed", report, Option.none());

  return { ...explored, report };
};

/**
 * Rules and explorations: `Explore.rule(sentence, function* () { … }, { at })` declares what must
 * hold, reading what it yields (`yield* Db.rows(list)`; `yield* Explore.before(reader)` for its
 * value at the previous check), checked by stories (`story.with({ rules })`) and explorations
 * alike; `Explore.source` declares what can happen; `Explore.run` explores every sequence of it,
 * deterministically.
 */
export const Explore = { rule, before, source, run } as const;
