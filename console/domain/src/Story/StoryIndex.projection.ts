import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Run } from "../Run/Run.aggregate.ts";
import { StoryRecorded } from "./AddStory.command.ts";
import { RunStories, StoryListed } from "./RunStories.stream.ts";

/** Lists every recorded story on its run's stream. */
export class StoryIndex extends Domain.Projection("StoryIndex", {
  from: [Run],
  key: Run,
  on: [StoryRecorded],
  writes: [RunStories],
}) {}

export const StoryIndexLive = StoryIndex.toLayer(
  Effect.gen(function* () {
    const stories = yield* RunStories;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        const { org, project, story, summary } = input.event;
        yield* stories.append(
          input,
          new StoryListed({ org, project, slug: story.slug, story, summary }),
        );
      }
    });
  }),
);
