import { causeFromError, createEffectLogic } from "@xstate/effect";
import { Cause, Context, Effect, Option } from "effect";
import type { AnyActorLogic } from "xstate";
import type { TaggedFailure } from "../state";
import type { Input } from "../values";

/** A declared `HighAlch` command, as a mark holds it (to compare it with what a machine ran). */
export interface Marked {}

/** Under this key, actor logic made from a `HighAlch` command holds that command. */
const tag: unique symbol = Symbol.for("@highalch/db/xstate/command");

/** A `HighAlch` command as a machine invokes it: anything with `effect(input)`. */
export type Invocable<I, A, E> = {
  readonly effect: (input: I) => Effect.Effect<A, E>;
};

/**
 * Runs the commands a machine invokes when one is provided: a story provides it to a machine it
 * runs (`Machine.start`), so they run on the story's client and are recorded. Without it,
 * `invoke` runs `command.effect(input)` on the client the `Provider` registered, as in production.
 */
export class Runner extends Context.Service<
  Runner,
  {
    readonly run: <I extends Input, A, E>(
      command: Invocable<I, A, E>,
      input: I,
    ) => Effect.Effect<A, E>;
  }
>()("@highalch/db/xstate/Runner") {}

/** Marks actor logic as invoking `command`, so stories can see what a machine asked for. */
export const mark = <L extends AnyActorLogic>(logic: L, command: Marked): L => {
  Object.defineProperty(logic, tag, { value: command, enumerable: false });

  return logic;
};

/** The command marked actor logic invokes, if it is marked. */
export const commandOf = (logic: AnyActorLogic | undefined): Option.Option<Marked> =>
  Option.flatMap(Option.fromUndefinedOr(logic), (marked) => {
    const command: Marked | undefined = Object.getOwnPropertyDescriptor(marked, tag)?.value;

    return Option.fromUndefinedOr(command);
  });

/**
 * The actor logic a machine invokes a `HighAlch` command with: `@xstate/effect`'s
 * `createEffectLogic` over `command.effect(input)`, so the invoked actor's output is the `Settled`
 * value and its error the command's typed rejection (`onError`'s `event.error` holds it inside an
 * `EffectFailure`; `rejection(event.error)` answers the original instance). It is
 * marked with its command, so a story sees, stepping the machine purely, which command a transition asked
 * for, with which input (`asked(command, input)`). Register it in `setup({ actors })` (or
 * `setupEffect`) and invoke it with the command's input:
 *
 * ```ts
 * const editor = setupEffect({ actors: { rename: invoke(notes.rename) } }).createMachine({
 *   states: { Saving: { invoke: { src: "rename", input: ({ context }) => context.draft, onDone, onError } } },
 * });
 * ```
 *
 * Run the machine with `createEffectActor`. Plain XState logic works too when marked:
 * `mark(createAsyncLogic({ run: ({ input }) => command.result(input) }), command)`.
 */
export const invoke = <I extends Input, A, E extends TaggedFailure>(command: Invocable<I, A, E>) =>
  mark(
    createEffectLogic({
      effect: ({ input }: { readonly input: I }): Effect.Effect<A, E> =>
        Effect.flatMap(Effect.serviceOption(Runner), (runner) =>
          Option.match(runner, {
            onNone: () => command.effect(input),
            onSome: (bound) => bound.run(command, input),
          }),
        ),
    }),
    command,
  );

/**
 * The typed rejection an invoked command failed with, read from `onError`'s `event.error`:
 * `@xstate/effect` hands a failed Effect over as an `EffectFailure` around its `Cause`, and this
 * answers the original instance inside. A defect or an interruption (no typed failure) answers
 * the error as it was given.
 *
 * ```ts
 * onError: ({ event }) => ({
 *   target: isTagged(rejection(event.error), "NoteMissing") ? "Stale" : "Failed",
 * }),
 * ```
 */
export const rejection = (error: unknown): unknown =>
  Option.getOrElse(Cause.findErrorOption(causeFromError(error)), () => error);
