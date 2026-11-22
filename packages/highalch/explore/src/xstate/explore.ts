import { Option } from "effect";
import type { AnyStateMachine, EventFromLogic } from "xstate";
import { getShortestPaths, getSimplePaths } from "xstate/graph";
import {
  flatten,
  StoryFailure,
  type Rule,
  type Runner as Story,
  type Step,
  type Steps,
} from "@highalch/story";

/** One path through a model: its events, in order. */
export type Path<E> = ReadonlyArray<E>;

/** What `explore` needs: the model, how each of its events acts on a story, and limits. */
export type Exploration<M extends AnyStateMachine> = {
  /** A small machine that models what can happen (its events) and when (its guards). */
  readonly model: M;
  /** The events to try in every state (XState's graph traversal takes them as given). */
  readonly events: ReadonlyArray<EventFromLogic<M>>;
  /** The story steps of one model event; `index` counts the path's events from 0. */
  readonly steps: (event: EventFromLogic<M>, index: number) => Steps;
  /** Steps before every path (history, opened sources). */
  readonly before?: Steps;
  /** Steps after every path (resume the feed, wait for every command). */
  readonly after?: Steps;
  /** The story runner each path runs on (a fresh world per path). */
  readonly story: Story;
  /** Checked at their moments (`at`) on every path. */
  readonly rules: ReadonlyArray<Rule>;
  /** Paths longer than this many events are not run (default 4). */
  readonly maxLength?: number;
  /** At most this many paths run, in their deterministic order (default 200). */
  readonly maxPaths?: number;
  /** Shrinks a failing path to a shorter one that still fails (default true). */
  readonly shrink?: boolean;
  /** At most this many model states are traversed (default 10 000): the model must be finite. */
  readonly limit?: number;
};

/** What an exploration ran. */
export type Explored = { readonly paths: number; readonly steps: number };

const typeOf = (event: { readonly type: string }) => event.type;

const keyOf = <E extends { readonly type: string }>(path: Path<E>) =>
  path.map((event) => JSON.stringify(event)).join(" ");

/**
 * The paths to run: XState's `getShortestPaths` and `getSimplePaths` (`xstate/graph`) over the
 * model (which must be finite: bound it with a counter in its context), without the initial step, deduplicated, without those that a longer path to run
 * contains as a prefix (every step of a path is checked, so its prefixes are), at most
 * `maxLength` events, ordered by length then by their events.
 */
export const pathsOf = <M extends AnyStateMachine>(
  model: M,
  events: ReadonlyArray<EventFromLogic<M>>,
  maxLength: number,
  limit = 10_000,
): ReadonlyArray<Path<EventFromLogic<M>>> => {
  const options = { events: [...events], limit };

  const found = [...getShortestPaths(model, options), ...getSimplePaths(model, options)].flatMap(
    (path) => {
      const happened = path.steps.flatMap((each) => {
        if (/^@?xstate\./.test(each.event.type)) return [];

        return [each.event];
      });

      if (happened.length === 0 || happened.length > maxLength) return [];

      return [happened];
    },
  );

  const unique = new Map(found.map((path) => [keyOf(path), path] as const));
  const keys = [...unique.keys()];

  return [...unique.entries()]
    .flatMap(([key, path]) => {
      if (keys.some((other) => other !== key && other.startsWith(`${key} `))) return [];

      return [path];
    })
    .sort((a, b) => a.length - b.length || keyOf(a).localeCompare(keyOf(b)));
};

/** The steps of a path, and which event each step belongs to (`-1` before or after them). */
const stepsOf = <M extends AnyStateMachine>(
  exploration: Exploration<M>,
  path: Path<EventFromLogic<M>>,
) => {
  const owners: Array<number> = [];
  const list: Array<Step> = [];

  const add = (steps: Steps | undefined, owner: number) => {
    for (const each of flatten([steps ?? []])) {
      list.push(each);
      owners.push(owner);
    }
  };

  add(exploration.before, -1);
  path.forEach((event, index) => add(exploration.steps(event, index), index));
  add(exploration.after, path.length);

  return { list, owners };
};

/** Runs one path; the failure, if any, with the events up to the one whose step failed. */
const attempt = async <M extends AnyStateMachine>(
  exploration: Exploration<M>,
  path: Path<EventFromLogic<M>>,
): Promise<
  Option.Option<{ readonly failure: StoryFailure; readonly prefix: Path<EventFromLogic<M>> }>
> => {
  const { list, owners } = stepsOf(exploration, path);

  try {
    await exploration.story.with({ rules: exploration.rules })(list);

    return Option.none();
  } catch (error) {
    if (!(error instanceof StoryFailure)) throw error;

    const owner = owners[error.step - 1] ?? path.length;

    return Option.some({ failure: error, prefix: path.slice(0, Math.min(owner + 1, path.length)) });
  }
};

/** Drops events from a failing path while it still fails; the shortest failing path found. */
const shrunk = async <M extends AnyStateMachine>(
  exploration: Exploration<M>,
  failing: { readonly failure: StoryFailure; readonly prefix: Path<EventFromLogic<M>> },
) => {
  let best = failing;
  let changed = true;

  while (changed) {
    changed = false;

    for (const index of best.prefix.keys()) {
      const shorter = best.prefix.filter((_, position) => position !== index);

      if (shorter.length === 0) continue;

      const result = await attempt(exploration, shorter);

      if (Option.isSome(result)) {
        best = result.value;
        changed = true;
        break;
      }
    }
  }

  return best;
};

/**
 * Model-based stories: enumerates the model's paths (XState's graph utilities) and runs each as a
 * story (`before`, each event's steps, `after`), checking the rules at their moments. Fails
 * with the shortest failing path it found (shrunk), as a readable event sequence, and the story's
 * own report. Deterministic: the same model and options run the same paths in the same order.
 */
export const explore = async <M extends AnyStateMachine>(
  exploration: Exploration<M>,
): Promise<Explored> => {
  const paths = pathsOf(
    exploration.model,
    exploration.events,
    exploration.maxLength ?? 4,
    exploration.limit,
  ).slice(0, exploration.maxPaths ?? 200);

  let steps = 0;

  for (const [index, path] of paths.entries()) {
    const result = await attempt(exploration, path);

    steps += stepsOf(exploration, path).list.length;

    if (Option.isNone(result)) continue;

    const found =
      exploration.shrink === false ? result.value : await shrunk(exploration, result.value);

    throw new Error(
      [
        `A generated story failed (path ${index + 1} of ${paths.length}): ${found.prefix.map(typeOf).join(" → ")}`,
        `  events: ${found.prefix.map((event) => JSON.stringify(event)).join(", ")}`,
        found.failure.message,
      ].join("\n"),
      { cause: found.failure },
    );
  }

  return { paths: paths.length, steps };
};
