import type * as Domain from "@alchemy.run/domain";
import { Option } from "effect";
import type { Hosting } from "./host";
import type { Invariant } from "./invariants";
import { Mismatch, Stage } from "./stage";
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

/** The options of a story: its clients' settings, its first scope, and invariants to keep. */
export type StoryOptions = Options & {
  /** The scope of the story's first client; `as(scope, ...)` steps open others. */
  readonly scope: string;
  /** Checked after every step and at the end. */
  readonly invariants?: ReadonlyArray<Invariant>;
  /** The story's name: what kinds of steps that write files per story (a screen) name them by. */
  readonly name?: string;
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

/** Checks every invariant; the violations as a failure of `number`. */
const keep = async (
  stage: Stage,
  invariants: ReadonlyArray<Invariant>,
  steps: ReadonlyArray<Step>,
  number: number,
  final: boolean,
) => {
  for (const invariant of invariants) {
    const violations = await invariant.check(stage, { final });

    if (violations.length > 0)
      throw new StoryFailure(
        number,
        `${final ? "At the end of the story" : `After step ${number} (${steps[number - 1]?.label})`}, "${invariant.name}" does not hold`,
        violations,
        reportOf(steps, final ? steps.length + 1 : number),
      );
  }
};

/** What a hosted story runs on: how to host its Domain, and its clients' options. */
type Setup = { readonly hosting: Hosting<Domain.Api.Any>; readonly options: StoryOptions };

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

  const stage = new Stage(
    world,
    Option.flatMap(setup, ({ options }) => Option.fromUndefinedOr(options.name)),
  );

  const invariants = Option.match(setup, {
    onNone: () => [],
    onSome: ({ options }) => options.invariants ?? [],
  });

  const kept = async (number: number, final: boolean) => {
    if (Option.isSome(world)) await keep(stage, invariants, steps, number, final);
  };

  try {
    for (const [index, each] of steps.entries()) {
      const number = index + 1;

      stage.step = number;

      if (Option.isSome(world)) world.value.step = number;

      try {
        await each.run(stage);
        await stage.passed({ step: number, label: each.label });
      } catch (error) {
        if (error instanceof StoryFailure) throw error;

        const { reason, detail } = why(error);

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

    const ended = await stage.close();

    if (Option.isSome(ended)) throw ended.value;
  } catch (error) {
    await stage.close();

    throw error;
  } finally {
    if (Option.isSome(world)) await world.value.dispose();
  }
};

/** A story runner: call it with steps inside your test runner's test; it returns a promise. */
export type Story = ((...steps: ReadonlyArray<Steps>) => Promise<void>) & {
  /** The same runner with other options (invariants, clock, settings); a hosted story's only. */
  readonly with: (options: Partial<StoryOptions>) => Story;
};

const runner = (setup: Option.Option<Setup>): Story => {
  const story = (...steps: ReadonlyArray<Steps>) => play(setup, flatten(steps));

  const more = (options: Partial<StoryOptions>) =>
    Option.match(setup, {
      onNone: () => {
        throw new Error(
          "A hostless story has no clients, clock or invariants to set: Story.make(hosting, options) makes a hosted one",
        );
      },
      onSome: (hosted) =>
        runner(Option.some({ ...hosted, options: { ...hosted.options, ...options } })),
    });

  return Object.assign(story, { with: more });
};

/**
 * The story runner. Hosted, `make(memory({ api, layer }), { scope: "acc-1" })`: each call hosts a
 * fresh Domain and fresh clients and disposes them when it ends; data steps and machine steps
 * (`@highalch/story/xstate`) run on it in any order. Hostless, `make()`: no Domain, no
 * client, nothing started, for machines stepped purely; a data step fails at once, naming itself.
 * Call it inside a test: `await story(given(...), shows(...), when(...), settled("Committed"))`.
 */
export function make(): Story;
export function make<A extends Domain.Api.Any>(hosting: Hosting<A>, options: StoryOptions): Story;
export function make<A extends Domain.Api.Any>(
  hosting?: Hosting<A>,
  options?: StoryOptions,
): Story {
  if (hosting === undefined || options === undefined) return runner(Option.none());

  return runner(Option.some({ hosting, options }));
}

/** The failure's step, if it is a story's failure. */
export const failedStep = <E>(error: E) =>
  Option.map(
    Option.liftPredicate(error, (each) => each instanceof StoryFailure),
    (failure) => failure.step,
  );
