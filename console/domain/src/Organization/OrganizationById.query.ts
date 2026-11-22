import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mayRead } from "../Actor.ts";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { allow } from "../Reads.ts";
import { Organization } from "./Organization.aggregate.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationRow } from "./Organization.rows.ts";

/** One organisation, or `null` when it does not exist. */
export class OrganizationById extends Domain.Query(
  "OrganizationById",
  {
    input: { org: OrganizationId },
    success: Schema.NullOr(OrganizationRow),
    middleware: [Caller],
    rejects: [NotAllowed],
  },
  { description: "An organisation's name, owner and creation time." },
) {}

export const OrganizationByIdLive = OrganizationById.toLayer(
  Effect.gen(function* () {
    const organizations = yield* Organization;
    return Effect.fn("OrganizationById")(function* ({ org }) {
      yield* allow(mayRead(yield* CurrentActor, org));
      const state = yield* organizations.get(org);
      if (state._tag !== "Active") return null;
      return { org, name: state.name, owner: state.owner, createdAt: state.createdAt };
    });
  }),
);
