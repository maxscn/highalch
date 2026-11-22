import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Role } from "../Actor.ts";
import { Millis, UserId } from "../Ids.ts";
import { Organization } from "./Organization.aggregate.ts";
import { OrganizationId } from "./Organization.id.ts";

export const UserOrganization = Schema.Struct({
  org: OrganizationId,
  name: Schema.String,
  role: Role,
  createdAt: Millis,
});
export type UserOrganization = typeof UserOrganization.Type;

/** The organisations a user belongs to: their memberships, resolved when they authenticate. */
export class UserOrganizations extends Domain.View(
  "UserOrganizations",
  {
    from: [Organization],
    key: UserId,
    keyOf: { OrganizationCreated: ({ event }) => event.owner },
    state: Schema.Struct({ organizations: Schema.Array(UserOrganization) }),
    initial: { organizations: [] },
    evolve: {
      OrganizationCreated: (state, event, { source, at }) => ({
        organizations: [
          ...state.organizations.filter((o) => o.org !== source.id),
          {
            org: source.id,
            name: event.name,
            role: "owner" as const,
            createdAt: DateTime.toEpochMillis(at),
          },
        ],
      }),
    },
  },
  { description: "The organisations a user is a member of." },
) {}
