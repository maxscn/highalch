import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { Organization } from "./Organization.aggregate.ts";
import { OrganizationId } from "./Organization.id.ts";

/** Which organisation a Stripe customer belongs to: how payment events find their organisation. */
export class CustomerOrganization extends Domain.View(
  "CustomerOrganization",
  {
    from: [Organization],
    key: Schema.String,
    keyOf: { CustomerLinked: ({ event }) => event.customer },
    middleware: [Caller],
    rejects: [NotAllowed],
    state: Schema.Struct({ org: Schema.NullOr(OrganizationId) }),
    initial: { org: null },
    evolve: { CustomerLinked: (_, _e, { source }) => ({ org: source.id }) },
  },
  { description: "The organisation of a Stripe customer." },
) {}

/** Only the server's payment handling reads it. */
export const CustomerOrganizationLive = CustomerOrganization.toLayer(
  Effect.succeed(
    Effect.fn(function* () {
      if ((yield* CurrentActor)._tag !== "System") return yield* new NotAllowed();
    }),
  ),
);
