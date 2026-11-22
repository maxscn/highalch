import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Schema from "effect/Schema";
import { Role } from "../Actor.ts";
import { Millis, UserId } from "../Ids.ts";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationOverview } from "./OrganizationOverview.view.ts";

/** One member of an organisation. `id` is `<org>/<user>`. */
export const MemberRow = Schema.Struct({
  id: Schema.String,
  org: OrganizationId,
  user: UserId,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  role: Role,
  joinedAt: Millis,
});
export type MemberRow = typeof MemberRow.Type;

export const memberId = (org: string, user: string) => `${org}/${user}`;

/** The members of an organisation. */
export class MemberRows extends HighAlch.Rows("MemberRows", {
  feed: OrganizationChanges,
  row: MemberRow,
  key: "id",
  from: [OrganizationOverview],
  scope: ({ source }) => source.id,
  on: {
    OrganizationCreated: (_event, { source, state }) =>
      state?._tag === "Active"
        ? state.members.map((member) =>
            HighAlch.upserted({ id: memberId(source.id, member.user), org: source.id, ...member }),
          )
        : undefined,
  },
}) {}
