import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AppOrigin, onAppOrigin, ReturnUrlRefused } from "../AppOrigin.ts";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { Payments } from "../Payments.external.ts";
import { allow } from "../Reads.ts";
import { BillingAccountPending } from "./BillingAccountPending.rejection.ts";
import { Organization } from "./Organization.aggregate.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationMissing } from "./OrganizationMissing.rejection.ts";
import { isOwner } from "./Owner.ts";

/** The payment provider's billing portal, for the organisation's owner. */
export class PortalLink extends Domain.Query(
  "PortalLink",
  {
    input: { org: OrganizationId, returnUrl: Schema.String },
    success: Schema.Struct({ url: Schema.String }),
    middleware: [Caller],
    rejects: [NotAllowed, OrganizationMissing, BillingAccountPending, ReturnUrlRefused],
  },
  { description: "The billing portal (plan changes, payment methods, invoices) for an owner." },
) {}

export const PortalLinkLive = PortalLink.toLayer(
  Effect.gen(function* () {
    const organizations = yield* Organization;
    const payments = yield* Payments;
    const app = yield* AppOrigin;
    return Effect.fn("PortalLink")(function* ({ org, returnUrl }) {
      yield* allow(isOwner(yield* CurrentActor, org));
      yield* onAppOrigin(app.origin, returnUrl);
      const state = yield* organizations.get(org);
      if (state._tag !== "Active") return yield* new OrganizationMissing();
      const customer = state.entitlement.customer;
      if (customer === null) return yield* new BillingAccountPending();
      return yield* payments.portal({ customer, returnUrl });
    });
  }),
);
