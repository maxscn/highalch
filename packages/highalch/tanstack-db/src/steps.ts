import type { DbClient, Transaction } from "@tanstack/db";
import { Option, Predicate } from "effect";
import { Mismatch } from "@highalch/story/internal";
import { reader, type Reader } from "@highalch/story/internal";
import { partial, staged, type Step } from "@highalch/story/internal";
import type { Input, Tagged } from "@highalch/story/internal";
import { json, type Plain, type World } from "@highalch/story/internal";
import {
  clients,
  ended,
  type Clients,
  type Declared,
  type Observed,
  type Run,
  type Settled,
  type Shown,
  type Source,
} from "./state";

/**
 * Builds a data step: it acts on (or checks) the story's TanStack DB clients and the hosted world.
 * In a hostless story it fails at once, naming the step.
 */
export const dbStep = (label: string, run: (db: Clients, world: World) => Promise<void>): Step =>
  staged(label, async (stage) => {
    const world = stage.hosted(label);

    await run(await stage.use(clients), world);
  });

/**
 * Any check of the story's clients: their runs, the sources they observe, a client's `DbClient`,
 * the feed's entries (`db.entries()`); throw to fail.
 */
export const check = (label: string, assert: (db: Clients) => Promise<void> | void) =>
  dbStep(`check ${label}`, async (db) => {
    await assert(db);
  });

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

const asRow = (shown: Shown): Plain => ({ ...shown.row, $hasPendingWrites: shown.pending });

/** The rows a source shows, as `then` compares them: by key, with `$hasPendingWrites`. */
export type ShownRow<Row> = Row & { readonly $hasPendingWrites: boolean };

/** What a `then` step expects of rows: by key order (each compared partially), or a predicate. */
export type Expected<Row> =
  | ReadonlyArray<Partial<Row> & { readonly $hasPendingWrites?: boolean }>
  | ((rows: ReadonlyArray<ShownRow<Row>>) => boolean);

/** Which client a step acts as, and the source's label in reports. */
export type Scoped = { readonly as?: string };

/**
 * Opens a source (once) in the step's client. The world settles the first time a step reads it:
 * when the step opened it, or a rule's reader did before (a reader opens without settling).
 */
const opened = async <Row extends object>(db: Clients, source: Source<Row>, scope?: string) => {
  const { observed } = await db.observe(source, scope);

  if (!observed.awaited) {
    observed.awaited = true;
    await db.world.settle();
  }

  return observed;
};

/** Materialises a source in the step's client and keeps it observed (`settle: false`: as is). */
export const open = <Row extends object>(
  source: Source<Row>,
  options: Scoped & { readonly settle?: boolean } = {},
) =>
  dbStep(`open ${source.id ?? "source"}`, async (db, world) => {
    const { observed } = await db.observe(source, options.as);

    // Opened by a step, settled or left as it is: later steps read it as they find it.
    observed.awaited = true;

    if (options.settle !== false) await world.settle();
  });

/** The rows a source shows now, checked against what a `then` step expects of them. */
const rowsHold = <Row extends object>(observed: Observed, expected: Expected<Row>) => {
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
};

/** A read state as a `then` step names it: one of `match`'s own tags, or a typed error. */
export type ReadState = "Loading" | "Retrying" | "Ready" | "Missing" | Tagged;

/** Whether a state is what a `then` step expects: the tag (and fields), or the error's fields. */
const matches = (expected: ReadState, fields: Plain, actual: Tagged) => {
  if (Predicate.isString(expected))
    return Predicate.isTagged(actual, expected) && partial(fields, actual);

  return actual.constructor === expected.constructor && json(actual) === json(expected);
};

/** The source's read state now, checked against what a `then` step expects of it. */
const stateHolds = (observed: Observed, expected: ReadState, fields: Plain, single: boolean) => {
  const actual = observed.state(single);

  if (matches(expected, fields, actual)) return;

  const shown = Object.fromEntries(
    Object.entries(actual).filter(([field]) => !["data", "retry", "feed"].includes(field)),
  );

  throw new Mismatch(`${observed.label} is not in the expected state`, [
    `expected ${clip(json(expected))} ${clip(json(fields))}`,
    `observed ${clip(json(shown))}`,
  ]);
};

/**
 * What a `then` step expects of a source: its rows (by key, each compared partially, or a
 * predicate), or an object naming its rows and its read state, as `match` reads it (`Loading`,
 * `Retrying`, `Ready`, `Missing` with `single` for a `findOne`, or the typed error, compared by
 * class and fields); `fields` are fields of that state (`{ state: "Retrying", fields: { attempt: 2 } }`).
 */
export type Then<Row> =
  | Expected<Row>
  | {
      readonly rows?: Expected<Row>;
      readonly state?: ReadState;
      readonly fields?: Plain;
      readonly single?: boolean;
    };

type Parts<Row> = Exclude<Then<Row>, Expected<Row>>;

/** A `then` expectation as its parts: rows alone are the rows. */
const partsOf = <Row>(expected: Then<Row>): Parts<Row> => {
  if (Array.isArray(expected) || Predicate.isFunction(expected)) return { rows: expected };

  // SAFETY: neither a list of rows nor a predicate, so the object form.
  return expected as Parts<Row>;
};

/**
 * `Db.then`: a source shows what was expected in the step's client, as `useLiveQuery` over it would.
 * With rows to check, a source not yet observed is opened and settled first; a state alone is
 * read as the source is now.
 */
// Not exported as `then`: a module whose exports include `then` is a thenable to `import()`.
export const thenShows = <Row extends object>(
  source: Source<Row>,
  expected: Then<Row>,
  options: Scoped = {},
) =>
  dbStep(`then ${source.id ?? "source"}`, async (db) => {
    const { rows, state, fields, single } = partsOf(expected);

    const observed = await Option.match(Option.fromUndefinedOr(rows), {
      onNone: async () => (await db.observe(source, options.as)).observed,
      onSome: () => opened(db, source, options.as),
    });

    if (state !== undefined) stateHolds(observed, state, fields ?? {}, single ?? false);

    if (rows !== undefined) rowsHold(observed, rows);
  });

/** A command a `when` step can call: a declared command, bound to the story's client. */
export type Callable<I> = {
  readonly with: (options: {
    readonly client?: DbClient;
  }) => (input: I, callbacks?: { readonly onCommitted?: (value: Settled) => void }) => Transaction;
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
    return dbStep(`when ${command}`, async (db, world) => {
      await db.start(command, world.scope, "story", {}, (client) =>
        argument({
          client,
          activate: () => {
            const release = db.connector.activate(client);

            db.releases.push(release);
          },
        }),
      );
    });

  if (Predicate.isString(command) || Predicate.isFunction(argument))
    throw new Error("when(command, input) or when(label, (acting) => transaction)");

  const input = argument;

  return dbStep(`when ${clip(json(input), 80)}`, async (db, world) => {
    await db.start(
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
const last = (db: Clients): Run => {
  const run = db.runs.at(-1);

  if (!run) throw new Mismatch("no command ran before this step");

  return run;
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
  dbStep(`settled${expected ? ` ${expected}` : ""}`, async (db, world) => {
    const run = last(db);
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
export const rejected = (expected: Tagged) =>
  dbStep(`rejected ${expected._tag}`, async (db, world) => {
    const run = last(db);
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

/**
 * `reload(source)` reloads a source, as the `retry` a `match` handler receives does
 * (`collection.reload()`), on a collection that can reload. The step ends when the world is quiet.
 */
export const reload = <Row extends object>(source: Source<Row>, options: Scoped = {}) =>
  dbStep(`reload ${source.id ?? "source"}`, async (db, world) => {
    const { observed } = await db.observe(source, options.as);

    const collection = observed.collection;

    if (collection.reload === undefined)
      throw new Mismatch(`${observed.label} cannot reload: its collection has no reload()`);

    // A reload that fails waits for its retry on the story's clock: the step ends when the world
    // is quiet, not when the reload succeeded (`advance` lets the retry run).
    void collection.reload().catch(() => undefined);
    await world.settle();
  });

/**
 * `restart()` reloads the tab: the step's client (or `as`'s) closes, and the next step that needs
 * it opens a new one. Sources are opened again by the steps that read them, as a reloaded app
 * mounts again. Commands the closed client had not settled are gone with it; what a durable queue
 * sends again is recorded as the app's.
 */
export const restart = (options: Scoped = {}) =>
  dbStep("restart the client", async (db, world) => {
    await db.restart(options.as);
    await world.settle();
  });

/**
 * What a source shows in the step's client (or `as`'s), as a rule reads it: its rows by key, each
 * with `$hasPendingWrites`. A source not observed yet is opened (without settling the world).
 */
export const rows = <Row extends object>(
  source: Source<Row>,
  options: Scoped = {},
): Reader<ReadonlyMap<string, ShownRow<Row>>> =>
  reader(
    [
      "rows",
      source.id ?? "source",
      ...[options.as].filter((as) => as !== undefined).map((as) => `as ${as}`),
    ].join(" "),
    async (stage) => {
      stage.hosted(`rows of ${source.id ?? "source"}`);

      const db = await stage.use(clients);
      const { observed } = await db.observe(source, options.as);

      // SAFETY: an observed source's rows are its `Row`s, without TanStack DB's virtual fields.
      return new Map(observed.sorted().map(([key, shown]) => [key, asRow(shown) as ShownRow<Row>]));
    },
  );

/** A command the story's clients ran, as a rule reads it: its label, who ran it, how it ended. */
export type CommandOf = {
  readonly label: string;
  readonly by: string;
  readonly outcome: Run["outcome"]["_tag"];
};

/** The commands the story's clients ran so far, in order, as a rule reads them. */
export const commands = (): Reader<ReadonlyArray<CommandOf>> =>
  reader("commands", async (stage) => {
    stage.hosted("commands");

    const db = await stage.use(clients);

    return db.runs.map((run) => ({ label: run.label, by: run.by, outcome: run.outcome._tag }));
  });
