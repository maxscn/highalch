import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mayFollow } from "../Actor.ts";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { allow } from "../Reads.ts";
import { MemberRow, memberId } from "./Member.rows.ts";
import { Organization } from "./Organization.aggregate.ts";
import { OrganizationId } from "./Organization.id.ts";

/** The members of an organisation: for its members only (not its keys). */
export class Members extends Domain.Query(
  "Members",
  {
    input: { org: OrganizationId },
    success: Schema.Array(MemberRow),
    middleware: [Caller],
    rejects: [NotAllowed],
  },
  { description: "The members of an organisation and their roles." },
) {}

export const MembersLive = Members.toLayer(
  Effect.gen(function* () {
    const organizations = yield* Organization;
    return Effect.fn("Members")(function* ({ org }) {
      yield* allow(mayFollow(yield* CurrentActor, org));
      const state = yield* organizations.get(org);
      if (state._tag !== "Active") return [];
      return state.members.map((member) => ({ id: memberId(org, member.user), org, ...member }));
    });
  }),
);
