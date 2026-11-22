import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { OrganizationId } from "./Organization.id.ts";

export const Directory = Schema.Literal("all");

export class OrganizationListed extends Domain.Event("OrganizationListed", {
  org: OrganizationId,
}) {}

/** Every organisation, for scheduled jobs (retention). Not served to clients. */
export class OrganizationDirectory extends Domain.Stream(
  "OrganizationDirectory",
  { key: Directory, entries: [OrganizationListed] },
  { description: "Every organisation, in creation order." },
) {}
