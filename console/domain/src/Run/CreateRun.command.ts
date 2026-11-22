import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { RunContext } from "../Organization/OpenRun.command.ts";
import { RunId } from "./Run.id.ts";

export class RunCreated extends Domain.Event("RunCreated", {
  org: OrganizationId,
  ...RunContext,
}) {}

/**
 * Create the run its organisation admitted (`OpenRun`), sent by `RunIntake` only. Answers whose
 * run it is: an id another organisation already used stays theirs.
 */
export class CreateRun extends Domain.Command("CreateRun", {
  target: RunId,
  input: { org: OrganizationId, ...RunContext },
  events: [RunCreated],
  rejects: [],
  reply: { org: Schema.NullOr(OrganizationId) },
}) {}
