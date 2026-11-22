import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Schema from "effect/Schema";
import { Millis, UserId } from "../Ids.ts";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationOverview } from "./OrganizationOverview.view.ts";

/** An organisation as its pages show it. */
export const OrganizationRow = Schema.Struct({
  org: OrganizationId,
  name: Schema.String,
  owner: UserId,
  createdAt: Millis,
});
export type OrganizationRow = typeof OrganizationRow.Type;

/** The organisation itself, on its own feed. */
export class OrganizationRows extends HighAlch.Rows("OrganizationRows", {
  feed: OrganizationChanges,
  row: OrganizationRow,
  key: "org",
  from: [OrganizationOverview],
  scope: ({ source }) => source.id,
  on: {
    OrganizationCreated: (_event, { source, state }) =>
      state?._tag === "Active"
        ? HighAlch.upserted({
            org: source.id,
            name: state.name,
            owner: state.owner,
            createdAt: state.createdAt,
          })
        : undefined,
  },
}) {}
