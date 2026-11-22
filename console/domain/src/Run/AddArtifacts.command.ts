import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { RunCompleted } from "./FinishRun.command.ts";
import { Millis } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { RunId } from "./Run.id.ts";
import { DeclaredArtifact } from "./Run.values.ts";

export class ArtifactsDeclared extends Domain.Event("ArtifactsDeclared", {
  org: OrganizationId,
  /** The quota period the bytes were reserved in. */
  period: Millis,
  artifacts: Schema.Array(DeclaredArtifact),
}) {}

/**
 * Record artifacts its organisation accepted, with whether each body is uploaded (or already
 * stored) and its blob generation. Sent by `RunIntake` only.
 */
export class AddArtifacts extends Domain.Command("AddArtifacts", {
  target: RunId,
  input: { org: OrganizationId, period: Millis, artifacts: Schema.Array(DeclaredArtifact) },
  events: [ArtifactsDeclared, RunCompleted],
  rejects: [],
  /** Whether the run took it: `false` once it completed (expired) or for another organisation. */
  reply: { applied: Schema.Boolean },
}) {}
