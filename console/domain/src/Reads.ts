import * as Effect from "effect/Effect";
import { mayRead } from "./Actor.ts";
import { CurrentActor } from "./CurrentActor.context.ts";
import { InvalidCursor } from "./InvalidCursor.rejection.ts";
import { NotAllowed } from "./NotAllowed.rejection.ts";
import type { Project } from "./Project/Project.aggregate.ts";
import type { ProjectId } from "./Project/Project.id.ts";
import { ProjectMissing } from "./Project/ProjectMissing.rejection.ts";
import type { Run } from "./Run/Run.aggregate.ts";
import type { RunId } from "./Run/Run.id.ts";
import { RunMissing } from "./Run/RunMissing.rejection.ts";

/**
 * How queries check their caller: each reads the state that says whose data it is, then
 * `mayRead`, before it reads anything else.
 */

/** Succeeds when the check holds, else `NotAllowed`. */
export const allow = (allowed: boolean) => (allowed ? Effect.void : Effect.fail(new NotAllowed()));

/** A project the caller may read: its state, or why not. */
export const readableProject = (projects: (typeof Project)["Service"]) =>
  Effect.fn("readableProject")(function* (project: ProjectId) {
    const state = yield* projects.get(project);
    if (state._tag !== "Active") return yield* new ProjectMissing();
    yield* allow(mayRead(yield* CurrentActor, state.org, project));
    return state;
  });

/** A run the caller may read: its state, or why not. */
export const readableRun = (runs: (typeof Run)["Service"]) =>
  Effect.fn("readableRun")(function* (run: RunId) {
    const state = yield* runs.get(run);
    if (state._tag !== "Run") return yield* new RunMissing();
    yield* allow(mayRead(yield* CurrentActor, state.org, state.project));
    return state;
  });

/** A stream cursor (an entry `seq`) from a page's `after`. */
export const seqOf = (after: string | undefined) => {
  if (after === undefined) return Effect.succeed(undefined);
  const seq = Number(after);
  return Number.isInteger(seq) && seq >= 0 ? Effect.succeed(seq) : Effect.fail(new InvalidCursor());
};

/** The cursor of the next page of a stream read, `null` on the last. */
export const nextOf = (page: {
  readonly entries: ReadonlyArray<unknown>;
  readonly cursor: number | null;
}) => (page.cursor === null || page.entries.length === 0 ? null : String(page.cursor));
