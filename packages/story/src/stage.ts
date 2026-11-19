import { Option } from "effect";
import type { Slot, World } from "./world";

/** A failed expectation inside a step: what it was about, what it expected and what it saw. */
export class Mismatch extends Error {
  constructor(
    readonly reason: string,
    readonly detail: ReadonlyArray<string> = [],
  ) {
    super(reason);
  }
}

/** A step that passed: its number (from 1) and label. */
export type Done = { readonly step: number; readonly label: string };

/**
 * One run of a story, as every step sees it: the hosted world (`None` in a hostless story), the
 * number of the step running, and the state that kinds of steps keep for the length of the run
 * (a machine's snapshot or its actor). A step kind interprets itself against it: data steps read
 * the world through `hosted`, machine steps keep their machines in a `slot`.
 */
export class Stage {
  /** The step running now (from 1). */
  step = 0;
  private readonly slots = new Map<symbol, Slot>();
  private readonly afters: Array<(done: Done) => Promise<void>> = [];
  private readonly ends: Array<() => Promise<void>> = [];

  constructor(
    readonly world: Option.Option<World>,
    /** The story's name (`story.with({ name })`), for what a kind of step writes per story. */
    readonly name: Option.Option<string> = Option.none(),
  ) {}

  /**
   * Runs `run` after every later step that passed, the registering step included, before the
   * invariants (a screen captures a frame). A failure in it is that step's failure.
   */
  after = (run: (done: Done) => Promise<void>) => {
    this.afters.push(run);
  };

  /** Runs `run` when the story ends, passed or failed, before its world is disposed. */
  end = (run: () => Promise<void>) => {
    this.ends.push(run);
  };

  /** The runner calls this after each step that passed. */
  passed = async (done: Done) => {
    for (const run of this.afters) await run(done);
  };

  /** The runner calls this once when the story ends; the first failure, if any. */
  close = async (): Promise<Option.Option<unknown>> => {
    let failure = Option.none<unknown>();

    for (const run of this.ends.splice(0).reverse())
      await run().catch((error) => {
        if (Option.isNone(failure)) failure = Option.some(error);
      });

    return failure;
  };

  /**
   * The hosted world, for a step that needs one (a data step, a running machine). In a hostless
   * story it fails at once, naming the step.
   */
  hosted = (label: string): World =>
    Option.getOrThrowWith(
      this.world,
      () =>
        new Mismatch(
          `"${label}" needs a host, and this story has none: data steps and running machines need Story.make(hosting, options); a hostless story (Story.make()) steps machines purely`,
        ),
    );

  /** A value a step kind keeps for the length of the run, under its own private key. */
  slot = <T extends Slot>(key: symbol, make: () => T): T => {
    const known = this.slots.get(key);

    if (known) {
      // SAFETY: each step kind keys its own slot with a private symbol and one type.
      return known as T;
    }

    const made = make();

    this.slots.set(key, made);

    return made;
  };
}
