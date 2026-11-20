import type * as Aggregate from "@alchemy.run/domain/Aggregate";
import type { Step as AlchemyStep } from "@alchemy.run/domain/Story";
import { Effect, Exit, Option, Predicate } from "effect";
import type { Answer, Tagged } from "./values";
import { json, type World } from "./world";
import { Mismatch, type Stage } from "./stage";
import { transport } from "./wire";

/**
 * One step of a story: a label for its report and how it interprets itself against the story's
 * run (`Stage`). Steps are plain values, and every kind carries its own interpretation: the
 * Domain's steps (`step`) act on the hosted world, data, machine and screen steps keep their state
 * in adapters the stage builds (`stage.use(adapter)`), and a consumer's own kinds are built with
 * `staged`. One runner runs them all, in any order.
 */
export type Step = {
  readonly label: string;
  readonly run: (stage: Stage) => Promise<void>;
};

/** A step, or a list of them (helpers may return several). */
export type Steps = Step | ReadonlyArray<Steps>;

/**
 * Builds a step of the Domain: it acts on (or checks) the hosted world. In a hostless story it
 * fails at once, naming the step.
 */
export const step = (label: string, run: (world: World) => Promise<void>): Step => ({
  label,
  run: (stage) => run(stage.hosted(label)),
});

/**
 * Builds a step of any kind from the stage: `stage.world` (the hosted world, `None` in a hostless
 * story), `stage.hosted(label)` (the world, or a failure naming the step) and
 * `stage.use(adapter)` (an adapter's service: the state a kind of step keeps for the run, built
 * from its Layer). The data, machine and screen steps are built so.
 */
export const staged = (label: string, run: (stage: Stage) => Promise<void>): Step => ({
  label,
  run,
});

export { Mismatch };

/** Does `actual` hold every field of `expected`, deeply? */
export const partial = <E, A>(expected: E, actual: A): boolean => {
  if (Predicate.isObject(expected) && !Array.isArray(expected)) {
    if (!Predicate.isObject(actual)) return false;

    return Object.entries(expected).every(([field, value]) =>
      partial(value, Object.entries(actual).find(([name]) => name === field)?.[1]),
    );
  }

  return json(expected) === json(actual);
};

/**
 * Seeds history: events committed on an aggregate before the story continues, as alchemy's
 * `Story.given(ref, ...events)` does (through the model's stores; they reach projections and so
 * the row feed, but no policy). Then the world settles. Needs a host that can seed (`memory`).
 */
export const given = <A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  ...events: ReadonlyArray<Aggregate.EventOf<A>>
): Step => {
  // SAFETY: an aggregate's events are tagged instances (alchemy's `Story.given` reads them so).
  const tagged = events as ReadonlyArray<Tagged>;

  return step(
    `given ${ref.aggregate}/${String(ref.id)}: ${tagged.map((event) => event._tag).join(", ")}`,
    async (world) => {
      if (!world.host.seed) throw new Mismatch("this host cannot seed history; use `remote`");

      await world.host.seed(ref, tagged);
      await world.settle();
    },
  );
};

/**
 * Another client writes: a Domain command sent outside the story's clients, either to an
 * aggregate (`remote(ref, command)`, as alchemy's `Story.when`; needs a host that can send) or
 * through the Api client of the step's scope (`remote(label, (api) => api.RenameNote(...))`).
 * It must be accepted; then the world settles.
 */
export function remote<A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  command: Aggregate.CommandOf<A> & Tagged,
): Step;
export function remote<C, E>(
  label: string,
  send: (api: C) => Effect.Effect<Answer | void, E>,
): Step;
export function remote(
  target: Aggregate.Ref | string,
  command: Tagged | ((api: never) => Effect.Effect<Answer | void, Answer>),
): Step {
  if (Predicate.isString(target) && Predicate.isFunction(command))
    return step(`remote ${target}`, async (world) => {
      const api = await world.raw(world.scope);
      // SAFETY: the caller typed `api` as the Api client a reader of the scope uses.
      const exit = await Effect.runPromiseExit(command(api as never));

      if (Exit.isFailure(exit))
        throw new Mismatch(`the remote write failed: ${String(exit.cause)}`);

      await world.settle();
    });

  if (Predicate.isString(target) || Predicate.isFunction(command))
    throw new Error("remote(ref, command) or remote(label, (api) => effect)");

  const ref = target;
  const sent = command;

  return step(`remote ${ref.aggregate}/${String(ref.id)}: ${sent._tag}`, async (world) => {
    if (!world.host.send) throw new Mismatch("this host cannot send to an aggregate");

    const failed = await world.host.send(ref, sent, `story-remote:${world.next()}`);

    if (Option.isSome(failed))
      throw new Mismatch(`the remote ${sent._tag} failed: ${failed.value}`);

    await world.settle();
  });
}

/** The feed of the step's client drops (a transport failure); reconnecting fails until `resume`. */
export const drop = (error = transport()) =>
  step("drop the feed", async (world) => {
    world.wire().drop(error);
    await world.settle();
  });

/** The feed can connect again; its pending retries run now, and the world settles. */
export const resume = () =>
  step("resume the feed", async (world) => {
    world.wire().resume();

    while (world.clock.fireNext(Number.POSITIVE_INFINITY, ["retry"])) await world.settle();

    await world.settle();
  });

/** The feed stays connected and delivers nothing while muted. */
export const mute = (on = true) =>
  step(on ? "mute the feed" : "unmute the feed", async (world) => {
    world.wire().mute(on);
  });

/**
 * An endpoint (a query or command, by name) fails with a typed error for the step's client,
 * `times` times or until `recover`.
 */
export const fail = (name: string, error: Tagged, times?: number) =>
  step(`fail ${name} with ${error._tag}`, async (world) => {
    world.wire().fail(name, error, times);
  });

/** The endpoint answers again. */
export const recover = (name: string) =>
  step(`recover ${name}`, async (world) => {
    world.wire().recover(name);
  });

/** Every query of the step's client answers with what it saw when asked, but only at `release`. */
export const hold = () =>
  step("hold query answers", async (world) => {
    world.wire().hold();
  });

export const release = () =>
  step("release query answers", async (world) => {
    world.wire().release();
    await world.settle();
  });

/**
 * Time passes on the story's manual clock: every retry, reload debounce and settle timeout due
 * within `ms` fires, in time order, the world settling after each.
 */
export const advance = (ms: number) =>
  step(`advance ${ms} ms`, async (world) => {
    await world.advance(ms);
  });

/** Waits until nothing more happens by itself (see `World.settle`). */
export const settle = () => step("settle", (world) => world.settle());

/** Waits until every command ran so far has ended (as each adapter knows them), then settles. */
export const idle = () =>
  step("idle", async (world) => {
    for (const wait of world.idles) await wait();

    await world.settle();
  });

/** Any check of the world (the host's services, a scope's wire: `world.wire().sent`); throw to fail. */
export const check = (label: string, assert: (world: World) => Promise<void> | void) =>
  step(`check ${label}`, async (world) => {
    await assert(world);
  });

/** Runs steps as the client of another scope (opened on first use): two accounts in one story. */
export const as = (scope: string, ...steps: ReadonlyArray<Steps>): ReadonlyArray<Step> =>
  flatten(steps).map((inner) => {
    const label = `[${scope}] ${inner.label}`;

    return staged(label, async (stage) => {
      const world = stage.hosted(label);
      const previous = world.scope;

      world.scope = scope;

      try {
        await inner.run(stage);
      } finally {
        world.scope = previous;
      }
    });
  });

/** Steps as one list. */
export const flatten = (steps: ReadonlyArray<Steps>): ReadonlyArray<Step> =>
  steps.flatMap((each): ReadonlyArray<Step> => {
    if (Array.isArray(each)) return flatten(each);

    // SAFETY: not an array, so one step.
    return [each as Step];
  });

/**
 * Alchemy's own story steps, run on the story's host: `Story.given(ref, ...events)` seeds history
 * (as `given`) and `Story.when(ref, command)` is another client's write (as `remote`). Other
 * alchemy steps assert server decisions only: run them with alchemy's `Story.make`.
 */
export const alchemy = (from: AlchemyStep): Step => {
  if (Predicate.isTagged(from, "Given") && "events" in from)
    return step(`given ${from.ref.aggregate}/${String(from.ref.id)}`, async (world) => {
      if (!world.host.seed) throw new Mismatch("this host cannot seed history; use `remote`");

      await world.host.seed(from.ref, from.events);
      await world.settle();
    });

  if (Predicate.isTagged(from, "When") && "command" in from)
    return step(
      `remote ${from.ref.aggregate}/${String(from.ref.id)}: ${from.command._tag}`,
      async (world) => {
        if (!world.host.send) throw new Mismatch("this host cannot send to an aggregate");

        const failed = await world.host.send(
          from.ref,
          from.command,
          from.commandId ?? `story-remote:${world.next()}`,
        );

        if (Option.isSome(failed))
          throw new Mismatch(`the remote ${from.command._tag} failed: ${failed.value}`);

        await world.settle();
      },
    );

  throw new Error(`alchemy(${from._tag}): only Story.given and Story.when run on a HighAlch story`);
};
