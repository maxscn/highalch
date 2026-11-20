import { rule } from "./rules";

/**
 * Rules and, next, explorations: `Explore.rule(sentence, { at, reads, holds })` declares what must
 * hold of a story's states, checked by stories (`story.with({ rules })`) and explorations alike.
 */
export const Explore = { rule } as const;
