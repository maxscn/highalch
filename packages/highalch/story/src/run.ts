import { Option } from "effect";
import type { Hosting } from "./host";
import { pathOf, readText, slug, write, type Place } from "./files";
import { due, type Rule } from "./rules";
import { Mismatch, Stage, type Capture, type Shown } from "./stage";
import { flatten, type Step, type Steps } from "./steps";
import { describeDefect, World, type Options } from "./world";

/** How far a story got with one step. */
export type StepReport = {
  readonly step: number;
  readonly label: string;
  readonly status: "passed" | "failed" | "not-run";
};

/**
 * A failed story. `message` names the failed step and why (expected vs observed, the row
 * histories), then lists every step: ✓ passed, ✗ failed, blank not run.
 */
export class StoryFailure extends Error {
  override readonly name = "StoryFailure";

  constructor(
    readonly step: number,
    readonly reason: string,
    readonly detail: ReadonlyArray<string>,
    readonly steps: ReadonlyArray<StepReport>,
  ) {
    super(
      [
        reason,
        ...detail.map((line) => `    ${line}`),
        "  steps:",
        ...steps.map(
          (each) =>
            `  ${{ passed: "✓", failed: "✗", "not-run": " " }[each.status]} ${each.step}. ${each.label}`,
        ),
      ].join("\n"),
    );
  }
}

/** A step as a story's observer sees it: passed (with its screen's frame, if painted) or failed. */
export type Observed = {
  readonly step: number;
  readonly label: string;
  readonly status: "passed" | "failed";
  readonly frame: Option.Option<Shown>;
};

/**
 * Who watches a story run step by step (an exploration streaming its tiles): told of each step
 * as it ends; `frames` has screens paint a frame after every step for it.
 */
export type Observer = {
  readonly frames: boolean;
  readonly step: (observed: Observed) => Promise<void>;
};

/** The options of a story: its world's settings, its first scope, and the rules it keeps. */
export type StoryOptions = Options & {
  /** The scope of the story's first client; `as(scope, ...)` steps open others. */
  readonly scope: string;
  /** Checked at the moments each names (`at`): after every step, at rest, at the end. */
  readonly rules?: ReadonlyArray<Rule>;
  /** The story's name: what kinds of steps that write files per story (a screen) name them by. */
  readonly name?: string;
  /** What the story captures (screens' frames); `compare` by default. */
  readonly capture?: Capture;
  /**
   * Keeps a text trace of the story (each step, then what every adapter shows: sources' rows,
   * machines, the screen's HTML) as a snapshot `<traces>/<name>.trace.txt`, compared like a
   * screen's baseline: a missing or different trace fails the story; `update` writes it.
   */
  readonly trace?: boolean;
  /** Where traces are kept (with `trace: true`). */
  readonly traces?: Place;
  /** Writes traces instead of comparing them. Never implicitly. */
  readonly update?: boolean;
  /** Writes the trace to this file, passed or failed, without comparing (an exploration's replay). */
  readonly traceTo?: string;
  /** Told of each step as it ends (an exploration streaming its tiles). */
  readonly observe?: Observer;
};

/** One step of a trace: its number, label, and what every adapter showed after it. */
const section = (number: number, label: string, lines: ReadonlyArray<string>) =>
  [`${number}. ${label}`, ...lines.map((line) => `   ${line}`)].join("\n");

/** Compares a story's trace with its snapshot (or writes it, with `update`). */
const snapshot = async (options: StoryOptions, trace: string) => {
  const name = Option.getOrThrowWith(
    Option.fromUndefinedOr(options.name),
    () => new Mismatch("a traced story needs a name, since its trace is named by it"),
  );

  const traces = Option.getOrThrowWith(
    Option.fromUndefinedOr(options.traces),
    () => new Mismatch("a traced story needs `traces`: where its trace snapshots are kept"),
  );

  const file = `${pathOf(traces)}/${slug(name)}.trace.txt`;

  if (options.update) return write(file, trace);

  const known = await readText(file);

  if (Option.isNone(known))
    throw new Mismatch(`the trace ${slug(name)}.trace.txt has no snapshot`, [
      "review the story, then write traces with the story's `update` option",
    ]);

  if (known.value === trace) return;

  const actual = file.replace(/\.trace\.txt$/, ".actual.trace.txt");
  const expected = known.value.split("\n");
  const line = trace.split("\n").findIndex((each, index) => each !== expected[index]);

  await write(actual, trace);

  throw new Mismatch(`the trace differs from its snapshot ${slug(name)}.trace.txt`, [
    `first at line ${line + 1}: expected ${JSON.stringify(expected[line] ?? "")}`,
    `actual:   ${actual}`,
  ]);
};

const reportOf = (steps: ReadonlyArray<Step>, failed: number): ReadonlyArray<StepReport> =>
  steps.map((each, index) => {
    const number = index + 1;
    let status: StepReport["status"] = "not-run";

    if (number < failed) status = "passed";
    else if (number === failed) status = "failed";

    return { step: number, label: each.label, status };
  });

const why = <E>(error: E) => {
  if (error instanceof Mismatch) return { reason: error.reason, detail: error.detail };

  if (error instanceof Error) return { reason: error.message, detail: [] };

  return { reason: describeDefect(error), detail: [] };
};

/** Checks every rule due now; the violations as a failure of `number`. */
const keep = async (
  stage: Stage,
  world: World,
  rules: ReadonlyArray<Rule>,
  steps: ReadonlyArray<Step>,
  number: number,
  final: boolean,
) => {
  // The end is when the story ran its course: what is in flight arrives, every timer fires.
  if (final && rules.some((rule) => rule.at === "end")) await world.exhaust();

  const moment = { rest: world.rest(), final };

  for (const rule of rules) {
    if (!due(rule, moment)) continue;

    // A rule that cannot be read (a reader whose adapter has nothing yet) fails the story, named.
    const violations = await rule
      .check(stage, moment)
      .catch((error: unknown) => [`it could not be checked: ${why(error).reason}`]);

    if (violations.length > 0)
      throw new StoryFailure(
        number,
        `${final ? "At the end of the story" : `After step ${number} (${steps[number - 1]?.label})`}, "${rule.name}" does not hold`,
        violations,
        reportOf(steps, final ? steps.length + 1 : number),
      );
  }
};

/** What a hosted story runs on: how to host its Domain, and its clients' options. */
type Setup = { readonly hosting: Hosting; readonly options: StoryOptions };

/**
 * Runs steps on a fresh stage (with a fresh host and world when the story has a host); throws a
 * `StoryFailure`; always disposes.
 */
export const play = async (setup: Option.Option<Setup>, steps: ReadonlyArray<Step>) => {
  const world = await Option.match(setup, {
    onNone: async () => Option.none<World>(),
    onSome: async ({ hosting, options }) =>
      Option.some(new World(await hosting(), options.scope, options)),
  });

  const options = Option.map(setup, (each) => each.options);

  const observer = Option.flatMap(options, (each) => Option.fromUndefinedOr(each.observe));

  const stage = new Stage(
    world,
    Option.flatMap(options, (each) => Option.fromUndefinedOr(each.name)),
    Option.match(options, { onNone: () => "compare", onSome: (each) => each.capture ?? "compare" }),
    Option.exists(observer, (each) => each.frames),
  );

  const observed = async (step: number, label: string, status: Observed["status"]) => {
    const frame = stage.shown;

    stage.shown = Option.none();

    if (Option.isSome(observer)) await observer.value.step({ step, label, status, frame });
  };

  const tracing = Option.match(options, {
    onNone: () => false,
    onSome: (each) => each.trace === true || each.traceTo !== undefined,
  });

  const trace: Array<string> = [];

  const traced = async (number: number, label: string) => {
    if (tracing) trace.push(section(number, label, await stage.described()));
  };

  const rules = Option.match(setup, {
    onNone: () => [],
    onSome: ({ options }) => options.rules ?? [],
  });

  const kept = async (number: number, final: boolean) => {
    if (Option.isSome(world)) await keep(stage, world.value, rules, steps, number, final);
  };

  try {
    for (const [index, each] of steps.entries()) {
      const number = index + 1;

      stage.step = number;
      stage.current = { _tag: each._tag ?? "Step", number, label: each.label };

      if (Option.isSome(world)) world.value.step = number;

      try {
        await each.run(stage);
        await stage.passed({ step: number, label: each.label });
        await observed(number, each.label, "passed");
        await traced(number, each.label);
      } catch (error) {
        if (error instanceof StoryFailure) throw error;

        await observed(number, each.label, "failed");

        const { reason, detail } = why(error);

        if (tracing) trace.push(`${number}. ${each.label}\n   ✗ ${reason}`);

        throw new StoryFailure(
          number,
          `Step ${number} (${each.label}) failed: ${reason}`,
          detail,
          reportOf(steps, number),
        );
      }

      await kept(number, false);
    }

    await kept(steps.length, true);

    await Option.match(options, {
      onNone: async () => {},
      onSome: async (each) => {
        if (each.trace === true) await snapshot(each, `${trace.join("\n")}\n`);
      },
    });

    const ended = await stage.close();

    if (Option.isSome(ended)) throw ended.value;
  } catch (error) {
    if (error instanceof StoryFailure && tracing)
      trace.push(`✗ ${error.reason}`, ...error.detail.map((line) => `   ${line}`));

    await stage.close();

    throw error;
  } finally {
    const to = Option.flatMap(options, (each) => Option.fromUndefinedOr(each.traceTo));

    if (Option.isSome(to)) await write(to.value, `${trace.join("\n")}\n`);

    if (Option.isSome(world)) await world.value.dispose();
  }
};

/** A story runner: call it with steps inside your test runner's test; it returns a promise. */
export type Story = ((...steps: ReadonlyArray<Steps>) => Promise<void>) & {
  /** The same runner with other options (rules, clock, name); a hosted story's only. */
  readonly with: (options: Partial<StoryOptions>) => Story;
  /** The runner's options (`None` for a hostless runner). */
  readonly options: Option.Option<StoryOptions>;
};

const runner = (setup: Option.Option<Setup>): Story => {
  const story = (...steps: ReadonlyArray<Steps>) => play(setup, flatten(steps));

  const more = (options: Partial<StoryOptions>) =>
    Option.match(setup, {
      onNone: () => {
        throw new Error(
          "A hostless story has no clients, clock or rules to set: Story.make(hosting, options) makes a hosted one",
        );
      },
      onSome: (hosted) =>
        runner(Option.some({ ...hosted, options: { ...hosted.options, ...options } })),
    });

  return Object.assign(story, {
    with: more,
    options: Option.map(setup, (hosted) => hosted.options),
  });
};

/**
 * The story runner. Hosted, `make(memory({ api, layer }), { scope: "acc-1" })`: each call hosts a
 * fresh Domain and fresh clients and disposes them when it ends; data steps and machine steps
 * (`@highalch/story/xstate`) run on it in any order. Hostless, `make()`: no Domain, no
 * client, nothing started, for machines stepped purely; a data step fails at once, naming itself.
 * Call it inside a test: `await story(given(...), shows(...), when(...), settled("Committed"))`.
 */
export function make(): Story;
export function make<C>(hosting: Hosting<C>, options: StoryOptions): Story;
export function make<C>(hosting?: Hosting<C>, options?: StoryOptions): Story {
  if (hosting === undefined || options === undefined) return runner(Option.none());

  // SAFETY: the runner reads only what every host has; the client type is the steps' to know.
  return runner(Option.some({ hosting: hosting as Hosting, options }));
}

/** The failure's step, if it is a story's failure. */
export const failedStep = <E>(error: E) =>
  Option.map(
    Option.liftPredicate(error, (each) => each instanceof StoryFailure),
    (failure) => failure.step,
  );
