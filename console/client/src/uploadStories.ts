import * as Effect from "effect/Effect";
import { findStories, readStory } from "./Stories.ts";
import { open, type Options } from "./Upload.ts";

export interface StoriesOptions extends Options {
  /** The folder `@highalch/story` wrote its reports to (`HIGHALCH_REPORT`). */
  readonly folder: string;
}

/**
 * Uploads a folder of story reports as one run of kind `stories`: every `<slug>/story.json` with the frames its
 * steps name, recorded with `RecordStory`, then completes the run. Offline (no URL or
 * credential) it writes them to `.highalch/runs/<runId>/stories/`.
 */
export const uploadStories = Effect.fn("uploadStories")(function* (options: StoriesOptions) {
  const paths = yield* findStories(options.folder);
  const stories = yield* Effect.forEach(paths, readStory);
  const upload = yield* open(options, "stories");
  yield* upload.stories(stories);
  return { outcome: yield* upload.complete(), stories: stories.length };
}, Effect.scoped);
