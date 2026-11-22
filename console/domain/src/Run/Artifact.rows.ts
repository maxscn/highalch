import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Schema from "effect/Schema";
import { Organization } from "../Organization/Organization.aggregate.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { RunId } from "./Run.id.ts";
import { AcceptedArtifact } from "./Run.values.ts";

/**
 * An artifact a run declared. `id` is `<run>.<n>`; its body is fetched through a link from the
 * `ArtifactLinks` query.
 */
export const ArtifactRow = Schema.Struct({
  ...AcceptedArtifact.fields,
  run: RunId,
  org: OrganizationId,
  project: ProjectId,
});
export type ArtifactRow = typeof ArtifactRow.Type;

/** The artifacts of an organisation's runs, as soon as the organisation accepts them. */
export class ArtifactRows extends HighAlch.Rows("ArtifactRows", {
  feed: OrganizationChanges,
  row: ArtifactRow,
  key: "id",
  from: [Organization],
  scope: ({ event, source }) => (event._tag === "ArtifactsAccepted" ? source.id : undefined),
  on: {
    ArtifactsAccepted: (event, { source }) =>
      event.artifacts.map((artifact) =>
        HighAlch.upserted({ ...artifact, run: event.run, org: source.id, project: event.project }),
      ),
  },
}) {}
