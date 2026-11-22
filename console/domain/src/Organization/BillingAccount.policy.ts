import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { system } from "../Actor.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Payments } from "../Payments.external.ts";
import { OrganizationCreated } from "./CreateOrganization.command.ts";
import { LinkCustomer } from "./LinkCustomer.command.ts";
import { Organization } from "./Organization.aggregate.ts";

/**
 * Every organisation gets its payment customer when it is created, so its owner can check out
 * at once: the provider makes the customer (the same one for a repeated request) and the
 * organisation links it, which is how payment events find their organisation.
 */
export class BillingAccount extends Domain.Policy("BillingAccount", {
  from: Organization,
  on: [OrganizationCreated],
}) {}

export const BillingAccountLive = BillingAccount.toLayer(
  Effect.gen(function* () {
    const payments = yield* Payments;
    const organizations = yield* Organization;
    return Effect.fn("BillingAccount")(function* ({ source, event }) {
      const { customer } = yield* payments.createCustomer({
        org: source.id,
        name: event.name,
        email: event.ownerEmail,
      });
      yield* organizations
        .send(source, new LinkCustomer({ customer }), { commandId: `link:${source.id}` })
        .pipe(Effect.provideService(CurrentActor, system("billing")), Effect.orDie);
    });
  }),
);
