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

/** What a rule reads of the story when it is checked: an adapter's view of its state. */
export type Reader<A> = { readonly read: (stage: Stage) => Promise<A> };

type Readers = Readonly<Record<string, Reader<unknown>>>;

/** The values of a rule's readers, by name. */
export type Read<R extends Readers> = {
  readonly [K in keyof R]: R[K] extends Reader<infer A> ? A : never;
};

/** The step a rule is checked after: its kind (`_tag`), number and label (`None` at the start). */
export type StepOf = { readonly _tag: string; readonly number: number; readonly label: string };

/**
 * What a rule's `holds` is given: its readers' values now, the step that just ran, and the same
 * at the rule's previous check (`previous`; at its first check, the values now).
 */
export type World<R extends Readers> = Read<R> & {
  readonly step: StepOf;
  readonly previous: Read<R> & { readonly step: StepOf };
};

/** How `Explore.rule` declares a rule: what it reads, when it is checked, and what must hold. */
export type Declaration<R extends Readers> = {
  readonly at?: At;
  /** The views the rule reads, by the names `holds` destructures: `{ list: Db.rows(list) }`. */
  readonly reads?: R;
  readonly holds: (world: World<R>) => boolean | Promise<boolean>;
};

const clip = (text: string, max = 400) => {
  if (text.length <= max) return text;

  return `${text.slice(0, max - 1)}…`;
};

/**
 * A rule, declared as a sentence and what must hold: `Explore.rule("the list matches the editor",
 * { at: "rest", reads: { list: Db.rows(list), editor: Machine.snapshot() }, holds: ({ list,
 * editor }) => … })`. A transition rule is the same shape: `holds` reads `previous` and `step`.
 * When it does not hold, the failure names the rule and shows what it read.
 */
export const rule = <R extends Readers = {}>(name: string, declaration: Declaration<R>): Rule => {
  const previous = new WeakMap<Stage, Read<R> & { readonly step: StepOf }>();

  return {
    name,
    at: declaration.at ?? "step",
    check: async (stage) => {
      const readers: Readers = declaration.reads ?? {};
      const entries = await Promise.all(
        Object.entries(readers).map(
          async ([key, reader]) => [key, await reader.read(stage)] as const,
        ),
      );

      // SAFETY: each value is its reader's, under the reader's own name.
      const now = { ...Object.fromEntries(entries), step: stage.current } as Read<R> & {
        readonly step: StepOf;
      };

      const before = previous.get(stage) ?? now;

      previous.set(stage, now);

      if (await declaration.holds({ ...now, previous: before })) return [];

      const { step: _step, ...read } = now;

      return [`it read ${clip(json(read))}`];
    },
  };
};
