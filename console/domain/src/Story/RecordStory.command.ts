import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { Count, Millis } from "../Ids.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { NotEntitled } from "../Organization/NotEntitled.rejection.ts";
import { RunContextStruct } from "../Organization/OpenRun.command.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { OrganizationMissing } from "../Organization/OrganizationMissing.rejection.ts";
import { QuotaExceeded } from "../Organization/QuotaExceeded.rejection.ts";
import { UsageReserved } from "../Organization/UsageReserved.event.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { RunId } from "../Run/Run.id.ts";
import { RunNotOpen } from "../Run/RunNotOpen.rejection.ts";
import { UnknownArtifact } from "../Run/UnknownArtifact.rejection.ts";
import { TargetMismatch } from "../TargetMismatch.rejection.ts";
import { StoryHeader, StorySummary } from "./Story.values.ts";

/** A story report of an open run was accepted. */
export class StoryAccepted extends Domain.Event("StoryAccepted", {
  run: RunId,
  project: ProjectId,
  /** The quota period and result rows reserved for it. */
  period: Millis,
  rows: Count,
  story: StoryHeader,
  summary: StorySummary,
  /** The run's context, so the run can be created from any of its writes. */
  context: RunContextStruct,
}) {}

/**
 * CI records a story report of an open run: the story and what its steps add up to. Its
 * `story.json` (`story.report`) and its frames (`frames`, their artifact ids) were declared as
 * the run's artifacts first; the steps stay in `story.json`. Recording a slug again replaces
 * that story. A report is charged like a results batch (`chargedStoryRows`).
 */
export class RecordStory extends Domain.Command("RecordStory", {
  target: OrganizationId,
  middleware: [Caller],
  input: {
    org: OrganizationId,
    run: RunId,
    story: StoryHeader,
    summary: StorySummary,
    frames: Schema.Array(Schema.String).check(Schema.isMaxLength(1_000)),
  },
  events: [UsageReserved, StoryAccepted],
  rejects: [
    OrganizationMissing,
    NotAllowed,
    NotEntitled,
    QuotaExceeded,
    RunNotOpen,
    UnknownArtifact,
    TargetMismatch,
  ],
}) {}
