import { Option } from "effect";
import type { Stage } from "./stage";
import { json } from "./world";

/**
 * When a rule is checked: after every `step` and at the end; whenever the story is at `rest`
 * (settled, nothing in flight: every command ended, every feed live), the end included; or only
 * at the `end`, once the story ran its course (what was in flight arrived, every timer fired).
 */
export type At = "step" | "rest" | "end";

/** The moment a rule is checked at: whether the story is at rest, and whether it ended. */
export type Moment = { readonly rest: boolean; readonly final: boolean };

/**
 * A property every state of a story must have. `name` is a sentence, written as is in failures.
 * `check` reads the story run (its world, the adapters' state through `stage.use(adapter)`) and
 * answers the violations it found, empty when it holds. Stories (`story.with({ rules })`) and
 * explorations check them at the moments `at` names.
 */
export type Rule = {
  readonly name: string;
  readonly at: At;
  readonly check: (stage: Stage, moment: Moment) => Promise<ReadonlyArray<string>>;
};

/** Whether a rule is due at a moment. */
export const due = (rule: Rule, moment: Moment) =>
  Option.match(
    Option.liftPredicate(rule.at, (at) => at === "end"),
    {
      onSome: () => moment.final,
      onNone: () => rule.at === "step" || moment.rest,
    },
  );

/** What a rule asks for when it yields: a reader's value now, or at the rule's previous check. */
export type Ask =
  | { readonly _tag: "Now"; readonly reader: Reader<unknown> }
  | { readonly _tag: "Before"; readonly reader: Reader<unknown> };

/** Something a rule yields (`yield* Db.rows(list)`) for a value of the story. */
export interface Yieldable<A> {
  readonly [Symbol.iterator]: () => Generator<Ask, A, unknown>;
}

/**
 * What a rule reads of the story when it is checked: an adapter's view of its state, by a name
 * that says what it is (`rows Notes…`, `machine editor`, `layout`). A rule yields it:
 * `const rows = yield* Db.rows(list)`; it is read then, and only if the rule gets there.
 */
export interface Reader<A> extends Yieldable<A> {
  readonly name: string;
  readonly read: (stage: Stage) => Promise<A>;
}

/** A reader named `name` that reads with `read`, for an adapter's rule readers. */
export const reader = <A>(name: string, read: (stage: Stage) => Promise<A>): Reader<A> => {
  const self: Reader<A> = {
    name,
    read,
    *[Symbol.iterator]() {
      // SAFETY: the rule's runner answers a reader's ask with that reader's value.
      return (yield { _tag: "Now", reader: self }) as A;
    },
  };

  return self;
};

/**
 * A reader's value at the rule's previous check, for a rule about a transition:
 * `const was = yield* Story.before(Db.rows(list))`. From the first check that asks for it, the
 * reader is read at every check; at that first one, before is now. Readers are told apart by name.
 */
export const before = <A>(read: Reader<A>): Yieldable<A> => ({
  *[Symbol.iterator]() {
    // SAFETY: the rule's runner answers a before-ask with its reader's earlier value.
    return (yield { _tag: "Before", reader: read }) as A;
  },
});

/** The step a rule is checked after: its kind (`_tag`), number and label (`None` at the start). */
export type StepOf = { readonly _tag: string; readonly number: number; readonly label: string };

/**
 * What must hold, given the step that just ran: a boolean, or a generator that yields what it
 * reads (`yield* Db.rows(list)`, `yield* Story.before(…)`) and returns whether it holds.
 */
export type Holds = (context: {
  readonly step: StepOf;
}) => boolean | Generator<Ask, boolean, unknown>;

/** A rule's settings: when it is checked (default: after every step). */
export type Settings = { readonly at?: At };

const clip = (text: string, max = 400) => {
  if (text.length <= max) return text;

  return `${text.slice(0, max - 1)}…`;
};

/** What a rule's reads were at a check, by reader name, and the readers it asked before of. */
type Memory = {
  readonly values: Map<string, unknown>;
  readonly tracked: Map<string, Reader<unknown>>;
};

/**
 * A rule, declared as a sentence, what must hold, and when it is checked:
 *
 * ```ts
 * Story.rule("a rejected rename keeps what you typed", function* () {
 *   const commands = yield* Db.commands();
 *   if (commands.at(-1)?.outcome !== "Rejected") return true;
 *
 *   const form = yield* Form.state(renameForm);
 *   const rows = yield* Db.rows(list);
 *   return form?.values.title !== rows.get("n1")?.title;
 * }, { at: "rest" });
 * ```
 *
 * It reads only what it yields, when it gets there. When it does not hold, the failure names the
 * rule by its sentence and shows what it read.
 */
export const rule = (name: string, holds: Holds, settings: Settings = {}): Rule => {
  const memories = new WeakMap<Stage, Memory>();

  return {
    name,
    at: settings.at ?? "step",
    check: async (stage) => {
      const memory = memories.get(stage) ?? { values: new Map(), tracked: new Map() };
      const now = new Map<string, unknown>();
      const shown: Array<readonly [string, unknown]> = [];

      const read = async (asked: Reader<unknown>) => {
        const value = await asked.read(stage);

        now.set(asked.name, value);

        return value;
      };

      const answer = async (ask: Ask) => {
        if (ask._tag === "Now") {
          const value = await read(ask.reader);

          shown.push([ask.reader.name, value]);

          return value;
        }

        const { name: asked } = ask.reader;
        const known = memory.tracked.has(asked) && memory.values.has(asked);

        memory.tracked.set(asked, ask.reader);

        const value = await Option.match(
          Option.liftPredicate(asked, () => known),
          {
            // Asked before at the previous check too: its value then.
            onSome: async () => memory.values.get(asked),
            // Asked for the first time: before is now.
            onNone: async () =>
              Option.getOrElse(
                Option.liftPredicate(now.get(asked), () => now.has(asked)),
                () => read(ask.reader),
              ),
          },
        );

        shown.push([`before: ${asked}`, value]);

        return value;
      };

      const result = holds({ step: stage.current });
      let held: boolean;

      if (typeof result === "boolean") held = result;
      else {
        let next = result.next();

        while (!next.done) next = result.next(await answer(next.value));

        held = next.value;
      }

      // What the rule asked the earlier value of is read every check, for the next one.
      for (const tracked of memory.tracked.values())
        if (!now.has(tracked.name)) await read(tracked);

      memories.set(stage, { values: now, tracked: memory.tracked });

      if (held) return [];

      // What it read, in the order it read it: one line each.
      return shown.map(([asked, value]) => `it read ${asked}: ${clip(json(value))}`);
    },
  };
};
