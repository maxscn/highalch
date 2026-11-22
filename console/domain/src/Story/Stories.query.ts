import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Caller } from "../Caller.middleware.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { readableRun } from "../Reads.ts";
import { Run } from "../Run/Run.aggregate.ts";
import { RunId } from "../Run/Run.id.ts";
import { RunMissing } from "../Run/RunMissing.rejection.ts";
import { allEntries } from "../Run/SnapshotComparison.policy.ts";
import { RunStories, type StoryListed } from "./RunStories.stream.ts";
import { StoryRow, storyRow } from "./Story.rows.ts";

/** A run's recorded stories: the latest recording of each slug, by slug. */
const latestOf = (entries: ReadonlyArray<{ readonly event: StoryListed }>) =>
  [...new Map(entries.map(({ event }) => [event.slug, event])).values()].sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );

/** A run's stories, by slug (a slug recorded again shows its latest report). */
export class Stories extends Domain.Query(
  "Stories",
  {
    input: { run: RunId },
    success: StoryRow,
    paged: true,
    middleware: [Caller],
    rejects: [NotAllowed, RunMissing],
  },
  { description: "A run's stories: status, steps passed, step kinds and frame statuses." },
) {}

const stories = Effect.gen(function* () {
  const readable = readableRun(yield* Run);
  const listed = yield* RunStories;
  return Effect.fn("RunStories")(function* (run: RunId) {
    const state = yield* readable(run);
    const entries = yield* allEntries((after) =>
      listed.list(Run.ref(run), { take: 200, ...(after === undefined ? {} : { after }) }),
    );
    return { state, latest: latestOf(entries) };
  });
});

/** Pages by slug: the cursor is the last slug of the page. */
export const StoriesLive = Stories.toLayer(
  Effect.map(stories, (read) =>
    Effect.fn("Stories")(function* ({ run }, page) {
      const { state, latest } = yield* read(run);
      const after = page.after;
      const rest = after === undefined ? latest : latest.filter((s) => s.slug > after);
      const shown = rest.slice(0, page.take);
      const last = shown.at(-1);
      return {
        entries: shown.map((recorded) => storyRow({ id: run, ...state }, recorded)),
        cursor: rest.length > shown.length && last !== undefined ? last.slug : null,
      };
    }),
  ),
);
