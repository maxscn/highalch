import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Count } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { RunId } from "./Run.id.ts";
import { ResultPart } from "./Run.values.ts";

/**
 * One stored results object: which part, where, and how many items. An object CI uploads
 * carries the digest and size its link is bound to; one the server wrote carries none.
 */
export class ResultPartListed extends Domain.Event("ResultPartListed", {
  org: OrganizationId,
  project: ProjectId,
  ...ResultPart.fields,
  sha256: Schema.NullOr(Schema.String),
  bytes: Schema.NullOr(Count),
}) {}

/** The stored result objects of a run in posting order: the index behind its result lists. */
export class RunResults extends Domain.Stream(
  "RunResults",
  { key: RunId, entries: [ResultPartListed] },
  { description: "The stored results objects of a run, in the order they were posted." },
) {}
