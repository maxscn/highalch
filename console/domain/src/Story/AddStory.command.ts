import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { RunCompleted } from "../Run/FinishRun.command.ts";
import { RunId } from "../Run/Run.id.ts";
import { StoryCounts } from "../Run/Run.values.ts";
import { StoryHeader, StorySummary } from "./Story.values.ts";

export class StoryRecorded extends Domain.Event("StoryRecorded", {
  org: OrganizationId,
  project: ProjectId,
  story: StoryHeader,
  summary: StorySummary,
  /** The run's story counts with this report (replacing the slug's previous one). */
  stories: StoryCounts,
}) {}

/** Record a story report its organisation accepted. Sent by `RunIntake` only. */
export class AddStory extends Domain.Command("AddStory", {
  target: RunId,
  input: { org: OrganizationId, story: StoryHeader, summary: StorySummary },
  events: [StoryRecorded, RunCompleted],
  rejects: [],
  /** Whether the run took it: `false` once it completed (expired) or for another organisation. */
  reply: { applied: Schema.Boolean },
}) {}
