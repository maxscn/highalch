import type * as Aggregate from "@alchemy.run/domain/Aggregate";
import type { Step as AlchemyStep } from "@alchemy.run/domain/Story";
import type { DbClient, Transaction } from "@tanstack/db";
import { Effect, Exit, Option, Predicate } from "effect";
import * as LowAlch from "@lowalch/tanstack-db";
import { activate, type Settled, type TaggedFailure } from "@lowalch/tanstack-db";
import type { Answer, Input } from "@lowalch/tanstack-db/internal";
import {
  json,
  macrotask,
  type Declared,
  type Reply,
  type Observed,
  type Plain,
  type Run,
  type Shown,
  type Source,
  type World,
} from "./world";
import { Mismatch, type Stage } from "./stage";
import { transport } from "./wire";

/**
 * One step of a story: a label for its report and how it interprets itself against the story's
 * run (`Stage`). Steps are plain values, and every kind carries its own interpretation: data steps
 * (`step`) act on the hosted world, machine steps (`@highalch/story/xstate`) keep their
 * machines on the stage, and a consumer's own kinds are built with `staged`. One runner runs them
 * all, in any order.
 */
export type Step = {
  readonly label: string;
  readonly run: (stage: Stage) => Promise<void>;
};

/** A step, or a list of them (helpers may return several). */
export type Steps = Step | ReadonlyArray<Steps>;

/**
 * Builds a data step: it acts on (or checks) the hosted world. In a hostless story it fails at
 * once, naming the step.
 */
export const step = (label: string, run: (world: World) => Promise<void>): Step => ({
  label,
  run: (stage) => run(stage.hosted(label)),
});

/**
 * Builds a step of any kind from the stage: `stage.world` (the hosted world, `None` in a hostless
 * story), `stage.hosted(label)` (the world, or a failure naming the step) and `stage.slot(key)`
 * (state the kind keeps for the run). The machine steps are built so.
 */
export const staged = (label: string, run: (stage: Stage) => Promise<void>): Step => ({
  label,
  run,
});

export { Mismatch };

const clip = (text: string, max = 100) => {
  if (text.length <= max) return text;

  return `${text.slice(0, max - 1)}…`;
};

/** A row in a report: its fields of interest (all when none are named), and its pending flag. */
const brief = (shown: Shown, fields: ReadonlyArray<string>) => {
  const picked = Option.match(
    Option.liftPredicate(fields, (named) => named.length > 0),
    {
      onNone: () => shown.row,
      onSome: (named) => Object.fromEntries(named.map((field) => [field, shown.row[field]])),
    },
  );

  return `${clip(json(picked))}${shown.pending ? " (pending)" : ""}`;
};

/** Every state one key showed in an observed source, in order: `a → b (pending) → -`. */
export const historyOf = (observed: Observed, key: string, fields: ReadonlyArray<string> = []) =>
  observed.history
    .flatMap((each) => {
      if (each.key !== key) return [];

      return [
        Option.match(each.shown, { onNone: () => "-", onSome: (shown) => brief(shown, fields) }),
      ];
    })
    .join(" → ");

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

const asRow = (shown: Shown): Plain => ({ ...shown.row, $hasPendingWrites: shown.pending });

/** The rows a source shows, as `shows` compares them: by key, with `$hasPendingWrites`. */
export type ShownRow<Row> = Row & { readonly $hasPendingWrites: boolean };

/** What a `shows` step expects: rows by key order (each compared partially), or a predicate. */
export type Expected<Row> =
  | ReadonlyArray<Partial<Row> & { readonly $hasPendingWrites?: boolean }>
  | ((rows: ReadonlyArray<ShownRow<Row>>) => boolean);

/** Which client a step acts as, and the source's label in reports. */
type Scoped = { readonly as?: string };

/** Opens a source (once) in the step's client; a newly opened source is settled. */
const opened = async <Row extends object>(world: World, source: Source<Row>, scope?: string) => {
  const { observed, opened: fresh } = await world.observe(source, scope);

  if (fresh) await world.settle();

  return observed;
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
  const tagged = events as ReadonlyArray<TaggedFailure>;

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
  command: Aggregate.CommandOf<A> & TaggedFailure,
): Step;
export function remote<C, E>(
  label: string,
  send: (api: C) => Effect.Effect<Answer | void, E>,
): Step;
export function remote(
  target: Aggregate.Ref | string,
  command: TaggedFailure | ((api: never) => Effect.Effect<Answer | void, Answer>),
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

/** Materialises a source in the step's client and keeps it observed (`settle: false`: as is). */
export const open = <Row extends object>(
  source: Source<Row>,
  options: Scoped & { readonly settle?: boolean } = {},
) =>
  step(`open ${source.id ?? "source"}`, async (world) => {
    await world.observe(source, options.as);

    if (options.settle !== false) await world.settle();
  });

/**
 * What a source shows now in the step's client, as `useLiveQuery` over it would: its rows by key
 * (each compared partially; `$hasPendingWrites` names a pending row), or a predicate over them.
 * A source not yet observed is opened and settled first.
 */
export const shows = <Row extends object>(
  source: Source<Row>,
  expected: Expected<Row>,
  options: Scoped = {},
) =>
  step(`shows ${source.id ?? "source"}`, async (world) => {
    const observed = await opened(world, source, options.as);
    const rows = observed.sorted();
    const actual = rows.map(([, shown]) => asRow(shown));

    const list = Option.liftPredicate(expected, Array.isArray);

    const fields = Option.match(list, {
      onNone: () => [],
      onSome: (rows: ReadonlyArray<Plain>) => [...new Set(rows.flatMap(Object.keys))],
    });

    const holds = Option.match(list, {
      onSome: (rows: ReadonlyArray<Plain>) =>
        rows.length === actual.length && rows.every((row, index) => partial(row, actual[index])),
      onNone: () => {
        // SAFETY: not an array, so the predicate form; the rows are the source's rows.
        const predicate = expected as (rows: ReadonlyArray<Plain>) => boolean;

        return predicate(actual);
      },
    });

    if (holds) return;

    const keys = new Set(observed.history.map((each) => each.key));

    throw new Mismatch(`${observed.label} does not show what was expected`, [
      Option.match(list, {
        onSome: (rows: ReadonlyArray<Plain>) => `expected ${clip(json(rows), 400)}`,
        onNone: () => "expected rows for which the predicate holds",
      }),
      `observed ${clip(json(rows.map(([, shown]) => asRow(shown))), 400)}`,
      ...[...keys].map((key) => `${key}: ${historyOf(observed, key, fields)}`),
    ]);
  });

/** A read state as a `state` step names it: one of `match`'s own tags, or a typed error. */
export type ReadState = "Loading" | "Retrying" | "Ready" | "Missing" | TaggedFailure;

/** Whether a state is what a `state` step expects: the tag (and fields), or the error's fields. */
const matches = (expected: ReadState, fields: Plain, actual: TaggedFailure) => {
  if (Predicate.isString(expected))
    return Predicate.isTagged(actual, expected) && partial(fields, actual);

  return actual.constructor === expected.constructor && json(actual) === json(expected);
};

/**
 * The source's read state now, as `match` reads a `useLiveQuery` result over it (the same
 * conversion): `Loading`, `Retrying`, `Ready`, `Missing` (with `single`, for a `findOne`),
 * optionally with some of the state's fields (`state(list, "Retrying", { attempt: 2 })`), or the
 * typed error, which compares by class and fields.
 */
export const state = <Row extends object>(
  source: Source<Row>,
  expected: ReadState,
  fields: Plain = {},
  options: Scoped & { readonly single?: boolean } = {},
) =>
  step(`state ${source.id ?? "source"}`, async (world) => {
    const { observed } = await world.observe(source, options.as);
    const actual = observed.state(options.single);

    if (matches(expected, fields, actual)) return;

    const shown = Object.fromEntries(
      Object.entries(actual).filter(([field]) => !["data", "retry", "feed"].includes(field)),
    );

    throw new Mismatch(`${observed.label} is not in the expected state`, [
      `expected ${clip(json(expected))} ${clip(json(fields))}`,
      `observed ${clip(json(shown))}`,
    ]);
  });

/** A command a `when` step can call: a `LowAlch` command, bound to the story's client. */
export type Callable<I> = {
  readonly with: (options: {
    readonly client?: DbClient;
  }) => (
    input: I,
    callbacks?: { readonly onCommitted?: (value: Settled<Reply>) => void },
  ) => Transaction;
};

/** What a `when(label, call)` step's call gets: the client, and `activate` for `.options`/`.paced`. */
export type Acting = {
  readonly client: DbClient;
  /** Registers the client for commands called without one (until the story ends). */
  readonly activate: () => void;
};

/**
 * The client runs a command, as a component calls it: `when(notes.rename, input)` calls the
 * declared command with its input on the step's client (`command.with({ client })(input)`), and
 * `when(label, ({ client, activate }) => transaction)` runs anything that returns a transaction
 * (`createOptimisticAction(command.options)`, `createPacedMutations({ ...command.paced })`). The
 * step does not wait: the next step sees the optimistic rows; `settled`/`rejected` wait.
 */
export function when<I extends Input>(command: Callable<I> & Declared, input: I): Step;
export function when(label: string, call: (acting: Acting) => Transaction): Step;
export function when(
  command: (Callable<Input> & Declared) | string,
  argument: Input | ((acting: Acting) => Transaction),
): Step {
  if (Predicate.isString(command) && Predicate.isFunction(argument))
    return step(`when ${command}`, async (world) => {
      await world.start(command, world.scope, "story", {}, (client) =>
        argument({
          client,
          activate: () => {
            const release = activate(client);

            world.releases.push(release);
          },
        }),
      );
    });

  if (Predicate.isString(command) || Predicate.isFunction(argument))
    throw new Error("when(command, input) or when(label, (acting) => transaction)");

  const input = argument;

  return step(`when ${clip(json(input), 80)}`, async (world) => {
    await world.start(
      clip(json(input), 80),
      world.scope,
      "story",
      input,
      (client, onCommitted) => command.with({ client })(input, { onCommitted }),
      Option.some(command),
    );
  });
}

/** The last command the story's clients ran (a `when` step or a machine's), or the one named. */
const last = (world: World): Run => {
  const run = world.runs.at(-1);

  if (!run) throw new Mismatch("no command ran before this step");

  return run;
};

/** Waits until a run ended; fails when the world went quiet and it had not. */
const pending = (run: Run) => Predicate.isTagged(run.outcome, "Pending");

export const ended = async (world: World, run: Run) => {
  if (pending(run)) await world.settle();

  for (let round = 0; round < 20 && pending(run); round += 1) await macrotask();

  if (pending(run))
    throw new Mismatch(`${run.label} has not settled and nothing more happens by itself`, [
      `waiting on the clock: ${json(world.clock.scheduled())} (advance it?)`,
    ]);

  return run.outcome;
};

const outcomeOf = (run: Run) =>
  Option.match(
    Option.liftPredicate(run.outcome, (outcome) => Predicate.isTagged(outcome, "Rejected")),
    {
      onSome: (outcome) => json(outcome),
      onNone: () => run.outcome._tag,
    },
  );

/**
 * The last command settled (the transaction completed): as `Committed` (the feed delivered its
 * change) or `Unconfirmed` (the settle timeout passed first), or either when no tag is given.
 */
export const settled = (expected?: "Committed" | "Unconfirmed") =>
  step(`settled${expected ? ` ${expected}` : ""}`, async (world) => {
    const run = last(world);
    const outcome = await ended(world, run);

    const holds =
      (Predicate.isTagged(outcome, "Committed") || Predicate.isTagged(outcome, "Unconfirmed")) &&
      (expected === undefined || Predicate.isTagged(outcome, expected));

    if (!holds)
      throw new Mismatch(`${run.label} did not settle as expected`, [
        `expected ${expected ?? "Committed | Unconfirmed"}`,
        `observed ${outcomeOf(run)}`,
      ]);

    await world.settle();
  });

/**
 * The last command was rejected with this typed error: the same class (its original instance)
 * with the same fields. The transaction rolled back.
 */
export const rejected = (expected: TaggedFailure) =>
  step(`rejected ${expected._tag}`, async (world) => {
    const run = last(world);
    const outcome = await ended(world, run);

    const holds =
      Predicate.isTagged(outcome, "Rejected") &&
      "error" in outcome &&
      outcome.error.constructor === expected.constructor &&
      json(outcome.error) === json(expected);

    if (!holds)
      throw new Mismatch(`${run.label} was not rejected as expected`, [
        `expected ${json(expected)}`,
        `observed ${outcomeOf(run)}`,
      ]);

    await world.settle();
  });

/** The feed of the step's client drops (a transport failure); reconnecting fails until `resume`. */
export const drop = (error = transport()) =>
  step("drop the feed", async (world) => {
    (await world.connect()).wire.drop(error);
    await world.settle();
  });

/** The feed can connect again; its pending retries run now, and the world settles. */
export const resume = () =>
  step("resume the feed", async (world) => {
    (await world.connect()).wire.resume();

    while (world.clock.fireNext(Number.POSITIVE_INFINITY, ["retry"])) await world.settle();

    await world.settle();
  });

/** The feed stays connected and delivers nothing while muted. */
export const mute = (on = true) =>
  step(on ? "mute the feed" : "unmute the feed", async (world) => {
    (await world.connect()).wire.mute(on);
  });

/**
 * An endpoint (a query or command, by name) fails with a typed error for the step's client,
 * `times` times or until `recover`.
 */
export const fail = (name: string, error: TaggedFailure, times?: number) =>
  step(`fail ${name} with ${error._tag}`, async (world) => {
    (await world.connect()).wire.fail(name, error, times);
  });

/** The endpoint answers again. */
export const recover = (name: string) =>
  step(`recover ${name}`, async (world) => {
    (await world.connect()).wire.recover(name);
  });

/** Every query of the step's client answers with what it saw when asked, but only at `release`. */
export const hold = () =>
  step("hold query answers", async (world) => {
    (await world.connect()).wire.hold();
  });

export const release = () =>
  step("release query answers", async (world) => {
    (await world.connect()).wire.release();
    await world.settle();
  });

/** An entity, as `LowAlch.reload(db, Rows)` takes it. */
type Entity = { readonly entityName: string };

const isEntity = <Row extends object>(target: Source<Row> | Entity): target is Entity =>
  Predicate.hasProperty(target, "entityName") && Predicate.isString(target.entityName);

/**
 * `reload(source)` reloads a source, as the `retry` a `match` handler receives does
 * (`collection.reload()`). `reload(Rows)` reloads every loaded subset of an entity in the step's
 * client, as `LowAlch.reload(db, Rows)` does after a write the feed does not carry; its debounce
 * (`reloadDelay`) passes, so the subsets have reloaded when the step ends.
 */
export function reload<Row extends object>(source: Source<Row>, options?: Scoped): Step;
export function reload(entity: Entity, options?: Scoped): Step;
export function reload<Row extends object>(target: Source<Row> | Entity, options: Scoped = {}) {
  if (isEntity(target))
    return step(`reload ${target.entityName}`, async (world) => {
      LowAlch.reload((await world.connect(options.as)).db, target);

      while (world.clock.fireNext(Number.POSITIVE_INFINITY, ["reload"])) await world.settle();

      await world.settle();
    });

  return step(`reload ${target.id ?? "source"}`, async (world) => {
    const { observed } = await world.observe(target, options.as);

    // A reload that fails waits for its retry on the story's clock: the step ends when the world
    // is quiet, not when the reload succeeded (`advance` lets the retry run).
    void observed.collection.reload().catch(() => undefined);
    await world.settle();
  });
}

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

/** Waits until every command ran so far has ended, then settles. */
export const idle = () =>
  step("idle", async (world) => {
    for (const run of world.runs) await ended(world, run);

    await world.settle();
  });

/** Any check of the world (the host's services, a client's wire, the runs); throw to fail. */
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
