import * as Domain from "@alchemy.run/domain";
import { RunId } from "./Run.id.ts";

export class RunPurged extends Domain.Event("RunPurged", {}) {}

/** Retention deleted the run's stored objects; its results and artifacts are gone. */
export class PurgeRun extends Domain.Command("PurgeRun", {
  target: RunId,
  input: {},
  events: [RunPurged],
  rejects: [],
}) {}
