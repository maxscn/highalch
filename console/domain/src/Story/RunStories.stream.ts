import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { Run } from "../Run/Run.aggregate.ts";
import { StoryHeader, StorySummary } from "./Story.values.ts";

/** One recorded story of a run; a later entry with the same slug replaces it. */
export class StoryListed extends Domain.Event("StoryListed", {
  org: OrganizationId,
  project: ProjectId,
  slug: Schema.String,
  story: StoryHeader,
  summary: StorySummary,
}) {}

/** The stories of a run, in recording order: the store behind the `Stories` query. */
export class RunStories extends Domain.Stream(
  "RunStories",
  { key: Run, entries: [StoryListed] },
  { description: "The story reports recorded for a run, in recording order." },
) {}
