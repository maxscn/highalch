import * as Domain from "@alchemy.run/domain";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { findPlan, findTopUp } from "../Billing/Plan.ts";
import { AppOrigin, onAppOrigin, ReturnUrlRefused } from "../AppOrigin.ts";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { Payments, type Purchase } from "../Payments.external.ts";
import { allow } from "../Reads.ts";
import { access } from "./Billing.ts";
import { BillingAccountPending } from "./BillingAccountPending.rejection.ts";
import { Organization } from "./Organization.aggregate.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationMissing } from "./OrganizationMissing.rejection.ts";
import { isOwner } from "./Owner.ts";

/** No plan or top-up of `Billing/Plan.ts` has this id. */
export class UnknownPurchase extends Domain.Rejection(
  "UnknownPurchase",
  { id: Schema.String },
  { httpApiStatus: 422 },
) {}

/** A paid period is current: plans change in the billing portal, not through a new checkout. */
export class AlreadySubscribed extends Domain.Rejection(
  "AlreadySubscribed",
  {},
  { httpApiStatus: 409 },
) {}

/** A top-up adds to a current paid period; there is none. */
export class NoActivePlan extends Domain.Rejection("NoActivePlan", {}, { httpApiStatus: 409 }) {}

/**
 * A checkout page for the organisation's owner: a plan while no paid period is current, or a
 * top-up during one. The price and name come from `Billing/Plan.ts`, never from the caller, and
 * the provider only ever sends the browser back to the app's own origin.
 */
export class CheckoutLink extends Domain.Query(
  "CheckoutLink",
  {
    input: {
      org: OrganizationId,
      purchase: Schema.Union([
        Schema.Struct({ plan: Schema.String }),
        Schema.Struct({ topUp: Schema.String }),
      ]),
      successUrl: Schema.String,
      cancelUrl: Schema.String,
    },
    success: Schema.Struct({ url: Schema.String }),
    middleware: [Caller],
    rejects: [
      NotAllowed,
      OrganizationMissing,
      UnknownPurchase,
      AlreadySubscribed,
      NoActivePlan,
      BillingAccountPending,
      ReturnUrlRefused,
    ],
  },
  { description: "A hosted checkout page for a plan or a top-up, for an organisation's owner." },
) {}

/** The purchase a checkout asks for, priced from the plan table. */
const priced = (purchase: { readonly plan: string } | { readonly topUp: string }) => {
  if ("plan" in purchase) {
    const plan = findPlan(purchase.plan);
    return plan === undefined
      ? Effect.fail(new UnknownPurchase({ id: purchase.plan }))
      : Effect.succeed<Purchase>({
          _tag: "Plan",
          id: plan.id,
          name: plan.name,
          amount: plan.price.amount,
          currency: plan.price.currency,
          interval: plan.interval,
        });
  }
  const topUp = findTopUp(purchase.topUp);
  return topUp === undefined
    ? Effect.fail(new UnknownPurchase({ id: purchase.topUp }))
    : Effect.succeed<Purchase>({
        _tag: "TopUp",
        id: topUp.id,
        name: topUp.name,
        amount: topUp.price.amount,
        currency: topUp.price.currency,
      });
};

export const CheckoutLinkLive = CheckoutLink.toLayer(
  Effect.gen(function* () {
    const organizations = yield* Organization;
    const payments = yield* Payments;
    const app = yield* AppOrigin;
    return Effect.fn("CheckoutLink")(function* ({ org, purchase, successUrl, cancelUrl }) {
      yield* allow(isOwner(yield* CurrentActor, org));
      yield* onAppOrigin(app.origin, successUrl, cancelUrl);
      const state = yield* organizations.get(org);
      if (state._tag !== "Active") return yield* new OrganizationMissing();
      const item = yield* priced(purchase);
      const current = access(state.entitlement, yield* Clock.currentTimeMillis)._tag === "Active";
      if (item._tag === "Plan" && current) return yield* new AlreadySubscribed();
      if (item._tag === "TopUp" && !current) return yield* new NoActivePlan();
      const customer = state.entitlement.customer;
      if (customer === null) return yield* new BillingAccountPending();
      return yield* payments.checkout({ customer, org, purchase: item, successUrl, cancelUrl });
    });
  }),
);
