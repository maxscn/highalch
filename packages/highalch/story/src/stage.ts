import { Cause, Context, Effect, Exit, Layer, Option, Scope } from "effect";
import type { StepOf } from "./rules";
import type { World } from "./world";

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

/** A frame a screen painted for a story's observer: its PNG and size. */
export type Shown = { readonly png: Uint8Array; readonly width: number; readonly height: number };

/**
 * What a story captures: `compare` paints frames and compares them with their baselines (a
 * story), `record` paints and writes them without comparing (an exploration's replay), `off`
 * paints nothing (an exploration's sequences).
 */
export type Capture = "compare" | "record" | "off";

/**
 * The story run an adapter is built for, as a service: an adapter's Layer reads it to reach the
 * hosted world, register work after every step and at the end, and name what it writes.
 */
export class CurrentStage extends Context.Service<CurrentStage, Stage>()("@highalch/story/Stage") {}

/**
 * A kind of step's state for one story run: a service and the Layer that builds it. A stage
 * builds each adapter once, on first use, shares the Layers adapters build on, and releases them
 * (their finalizers) when the story ends, before its world is disposed.
 */
export type Adapter<I, S> = {
  readonly service: Context.Key<I, S>;
  /**
   * Needs at most the stage: an adapter that builds on others provides their Layers to its own
   * (`Layer.provide(layer, clients.layer)`), and the stage builds each Layer once per run.
   */
  readonly layer: Layer.Layer<I, never, CurrentStage>;
};

/**
 * One run of a story, as every step sees it: the hosted world (`None` in a hostless story), the
 * number of the step running, the work registered after every step and at the end, and the
 * adapters (`use`) that kinds of steps keep their state in for the run (the clients a data step
 * reads, a machine's snapshot or actor, a mounted screen).
 */
export class Stage {
  /** The step running now (from 1). */
  step = 0;
  /** The step running now, as a rule sees it (`Start` before the first). */
  current: StepOf = { _tag: "Start", number: 0, label: "start" };
  private readonly afters: Array<(done: Done) => Promise<void>> = [];
  private readonly ends: Array<() => Promise<void>> = [];
  private readonly describers: Array<() => Promise<ReadonlyArray<string>>> = [];
  private readonly scope = Effect.runSync(Scope.make());
  private readonly memo = Layer.makeMemoMapUnsafe();
  private readonly built = new Map<unknown, Promise<unknown>>();

  constructor(
    readonly world: Option.Option<World>,
    /** The story's name (`story.with({ name })`), for what a kind of step writes per story. */
    readonly name: Option.Option<string> = Option.none(),
    /** What the story captures (frames): everything a story compares, by default. */
    readonly capture: Capture = "compare",
    /**
     * Whether a screen paints a frame after every step for the story's observer (an exploration
     * streaming its tiles), even when it captures nothing; it leaves it in `shown`.
     */
    readonly live: boolean = false,
  ) {}

  /** The frame a screen painted after the step that just ran, for the story's observer. */
  shown: Option.Option<Shown> = Option.none();

  /**
   * Adds what an adapter shows of its state to the story's trace (its sources' rows, a machine's
   * state, a screen's HTML): lines, read after each step when the story is traced.
   */
  describe = (run: () => Promise<ReadonlyArray<string>>) => {
    this.describers.push(run);
  };

  /** Every adapter's description now, in the order they were added. */
  described = async (): Promise<ReadonlyArray<string>> => {
    const lines: Array<string> = [];

    for (const run of this.describers) lines.push(...(await run()));

    return lines;
  };

  /**
   * Runs `run` after every later step that passed, the registering step included, before the
   * rules (a screen captures a frame). A failure in it is that step's failure.
   */
  after = (run: (done: Done) => Promise<void>) => {
    this.afters.push(run);
  };

  /** Runs `run` when the story ends, passed or failed, before its adapters are released. */
  end = (run: () => Promise<void>) => {
    this.ends.push(run);
  };

  /**
   * An adapter's service for this run, built from its Layer on first use (with this stage as its
   * `CurrentStage`); later uses get the same service.
   */
  use = <I, S>(adapter: Adapter<I, S>): Promise<S> => {
    const known = this.built.get(adapter.service);

    // SAFETY: built from this adapter, under its own service key.
    if (known) return known as Promise<S>;

    const provided = Option.match(this.world, {
      onNone: () => [],
      onSome: (world) => world.host.adapters ?? [],
    });

    const layer = adapter.layer.pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(CurrentStage, this), ...provided)),
    );

    const made = Effect.runPromise(
      Layer.buildWithMemoMap(layer, this.memo, this.scope).pipe(
        Effect.map((context) => Context.get(context, adapter.service)),
      ),
    );

    this.built.set(adapter.service, made);

    return made;
  };

  /** The runner calls this after each step that passed. */
  passed = async (done: Done) => {
    for (const run of this.afters) await run(done);
  };

  /**
   * The runner calls this once when the story ends: the registered ends (last first), then the
   * adapters' finalizers. The first failure, if any.
   */
  close = async (): Promise<Option.Option<unknown>> => {
    let failure = Option.none<unknown>();

    for (const run of this.ends.splice(0).reverse())
      await run().catch((error) => {
        if (Option.isNone(failure)) failure = Option.some(error);
      });

    const released = await Effect.runPromiseExit(Scope.close(this.scope, Exit.void));

    if (Exit.isFailure(released) && Option.isNone(failure))
      failure = Option.some(Cause.squash(released.cause));

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
}
