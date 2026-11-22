import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Count } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { RunId } from "./Run.id.ts";

/** Entry `n` of a run's stream is artifact `<run>.<n>`. */
export class ArtifactListed extends Domain.Event("ArtifactListed", {
  org: OrganizationId,
  project: ProjectId,
  id: Schema.String,
  name: Schema.String,
  mime: Schema.String,
  bytes: Count,
  sha256: Schema.String,
}) {}

/**
 * Every artifact a run's organisation accepted, in declaration order: the index upload and
 * download links are signed from.
 */
export class RunArtifacts extends Domain.Stream(
  "RunArtifacts",
  { key: RunId, entries: [ArtifactListed] },
  { description: "The artifacts of a run, one entry per declared artifact." },
) {}
