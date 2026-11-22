import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mayFollow } from "../Actor.ts";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { allow } from "../Reads.ts";
import { BillingRow, billingRow } from "./Billing.rows.ts";
import { Organization } from "./Organization.aggregate.ts";
import { OrganizationId } from "./Organization.id.ts";

/** An organisation's plan, period, limits and usage: for its members only. */
export class Billing extends Domain.Query(
  "Billing",
  {
    input: { org: OrganizationId },
    success: Schema.NullOr(BillingRow),
    middleware: [Caller],
    rejects: [NotAllowed],
  },
  { description: "An organisation's plan, paid period, limits (with top-ups) and usage." },
) {}

export const BillingLive = Billing.toLayer(
  Effect.gen(function* () {
    const organizations = yield* Organization;
    return Effect.fn("Billing")(function* ({ org }) {
      yield* allow(mayFollow(yield* CurrentActor, org));
      const state = yield* organizations.get(org);
      return state._tag === "Active" ? billingRow(org, state) : null;
    });
  }),
);
