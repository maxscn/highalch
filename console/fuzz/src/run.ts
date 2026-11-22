import * as fc from "fast-check";
import type { Capture, CaseContext } from "./adapter.ts";
import { isArbitrary, tagged, type ArbitraryOptions, type Source, type Subject } from "./cases.ts";
import { schemaHash } from "./hash.ts";

export interface RunOptions<S, A> extends ArbitraryOptions {
  readonly seed: number;
  /** Actions per sequence. Every generated sequence has exactly this many; shrinking shortens it. */
  readonly steps: number;
  /** Sequences explored before reporting. Default 100. */
  readonly runs?: number;
  /** Trace name. Default `"run"`. */
  readonly name?: string;
  /** What the trace exercises. Snapshots are compared per (subject, seed, step index). */
  readonly subject: Subject;
  /** Version of the action generator (see `Fuzz.cases`); the action schema's hash otherwise. */
  readonly version?: string;
  readonly initial: S;
  /** Action JSON Schema or fast-check arbitrary. */
  readonly actions: Source<A>;
  /** Pure transition. Must not mutate `state`. */
  readonly step: (state: S, action: A) => S;
  /** Throws when a state is invalid; checked after every step. */
  readonly invariant?: (state: S) => void;
  /** Called after every step of the reported trace (not during exploration). */
  readonly capture?: (state: S, ctx: CaseContext) => Promise<Capture> | Capture;
}

export interface Step<S, A> {
  readonly index: number;
  readonly action: A;
  readonly state: S;
  readonly capture?: Capture;
}

export interface Failure<A> {
  /** What `step` or `invariant` threw for the shrunk counterexample. */
  readonly error: unknown;
  readonly message: string;
  /** Index of the failing step. */
  readonly index: number;
  /** fast-check's shrunk action sequence (ends with the failing action). */
  readonly counterexample: ReadonlyArray<A>;
  readonly seed: number;
  /** fast-check `path` that replays the counterexample with `fc.assert(..., { seed, path })`. */
  readonly path: string;
  readonly shrinks: number;
}

export interface Run<S, A> {
  readonly name: string;
  readonly subject: Subject;
  readonly schemaHash: string;
  readonly seed: number;
  readonly initial: S;
  /**
   * On failure: the shrunk counterexample up to and including the failing step (a step that
   * threw has no state and is not included). Otherwise: the first explored sequence (path "0").
   */
  readonly trace: ReadonlyArray<Step<S, A>>;
  readonly failure: Failure<A> | null;
}

/**
 * Generates exactly `steps` items but shrinks like `fc.array(item, { maxLength: steps })`, so a
 * failing sequence can lose any action (not only trailing ones). Both arrays are fast-check
 * array arbitraries, so the generation context is valid for the shrinker.
 */
class Steps<T> extends fc.Arbitrary<Array<T>> {
  private readonly full: fc.Arbitrary<Array<T>>;
  private readonly any: fc.Arbitrary<Array<T>>;
  constructor(item: fc.Arbitrary<T>, steps: number) {
    super();
    this.full = fc.array(item, { minLength: steps, maxLength: steps });
    this.any = fc.array(item, { maxLength: steps });
  }
  generate(mrng: fc.Random, bias: number | undefined): fc.Value<Array<T>> {
    return this.full.generate(mrng, bias);
  }
  canShrinkWithoutContext(value: unknown): value is Array<T> {
    return this.any.canShrinkWithoutContext(value);
  }
  shrink(value: Array<T>, context: unknown): fc.Stream<fc.Value<Array<T>>> {
    return this.any.shrink(value, context);
  }
}

/** The arbitrary of action sequences `Fuzz.run` explores: exactly `steps` actions, shrinkable to fewer. */
export const sequence = <A>(actions: Source<A>, steps: number, options: ArbitraryOptions = {}) =>
  new Steps(tagged(actions, options), steps).map((items) => items.map((item) => item.value as A));

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Applies actions until one throws; returns the visited states and the failure point. */
const apply = <S, A>(options: RunOptions<S, A>, actions: ReadonlyArray<A>) => {
  const states: Array<S> = [];
  let state = options.initial;
  for (const [index, action] of actions.entries()) {
    try {
      state = options.step(state, action);
    } catch (error) {
      return { states, failed: { index, error } };
    }
    states.push(state);
    try {
      options.invariant?.(state);
    } catch (error) {
      return { states, failed: { index, error } };
    }
  }
  return { states, failed: undefined };
};

/**
 * Explores seeded action sequences against `initial` with fast-check, then replays one
 * sequence (the shrunk counterexample, or the first sequence when all pass) calling
 * `capture` after every step.
 */
export const run = async <S, A>(options: RunOptions<S, A>): Promise<Run<S, A>> => {
  const name = options.name ?? "run";
  let first: ReadonlyArray<A> | undefined;
  const details = fc.check(
    fc.property(sequence(options.actions, options.steps, options), (actions) => {
      first ??= actions;
      const { failed } = apply(options, actions);
      if (failed) throw failed.error;
    }),
    { seed: options.seed, numRuns: options.runs ?? 100 },
  );
  const chosen = details.failed && details.counterexample ? details.counterexample[0] : first;
  const actions = chosen ?? [];
  const { states, failed } = apply(options, actions);
  const path = details.failed ? (details.counterexamplePath ?? "0") : "0";
  const trace: Array<Step<S, A>> = [];
  for (const [index, state] of states.entries()) {
    const action = actions[index] as A;
    const capture = options.capture
      ? await options.capture(state, {
          name,
          id: `${options.seed}:step:${index}`,
          index,
          seed: options.seed,
          path,
          edges: [],
        })
      : undefined;
    trace.push({ index, action, state, ...(capture ? { capture } : {}) });
  }
  const failure: Failure<A> | null =
    details.failed && failed
      ? {
          error: failed.error,
          message: message(failed.error),
          index: failed.index,
          counterexample: actions,
          seed: options.seed,
          path,
          shrinks: details.numShrinks,
        }
      : details.failed
        ? {
            error: details.errorInstance,
            message: message(details.errorInstance),
            index: Math.max(0, actions.length - 1),
            counterexample: actions,
            seed: options.seed,
            path,
            shrinks: details.numShrinks,
          }
        : null;
  return {
    name,
    subject: options.subject,
    schemaHash: schemaHash(options.actions, isArbitrary(options.actions), options.version),
    seed: options.seed,
    initial: options.initial,
    trace,
    failure,
  };
};

const show = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * Thrown by {@link assertRun} when a sequence fails. Carries the whole {@link Run} (the trace
 * replaying the shrunk counterexample) plus the replay coordinates, like `fc.assert`'s error.
 * `cause` is what `step` or `invariant` threw.
 */
export class RunFailed<S = unknown, A = unknown> extends Error {
  readonly _tag = "RunFailed" as const;
  readonly run: Run<S, A>;
  readonly failure: Failure<A>;
  readonly seed: number;
  readonly path: string;
  readonly counterexample: ReadonlyArray<A>;
  constructor(run: Run<S, A>, failure: Failure<A>) {
    super(
      `${run.name} failed at step ${failure.index} after ${failure.shrinks} shrinks ` +
        `{ seed: ${failure.seed}, path: ${show(failure.path)} }\n` +
        `Counterexample: ${show(failure.counterexample)}\n` +
        `Error: ${failure.message}`,
      { cause: failure.error },
    );
    this.name = "RunFailed";
    this.run = run;
    this.failure = failure;
    this.seed = failure.seed;
    this.path = failure.path;
    this.counterexample = failure.counterexample;
  }
}

/**
 * Same as {@link run}, but rejects with {@link RunFailed} when a sequence fails (like
 * `fc.assert`); resolves with the passing run otherwise.
 */
export const assertRun = async <S, A>(options: RunOptions<S, A>): Promise<Run<S, A>> => {
  const result = await run(options);
  if (result.failure !== null) throw new RunFailed(result, result.failure);
  return result;
};
