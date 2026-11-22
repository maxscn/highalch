import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

const Currency = Schema.Literal("eur");

/** What a checkout sells, from `Billing/Plan.ts`: a monthly plan or a one-off top-up. */
export const Purchase = Schema.Union([
  Schema.TaggedStruct("Plan", {
    id: Schema.String,
    name: Schema.String,
    /** In the currency's minor unit. */
    amount: Schema.Number,
    currency: Currency,
    interval: Schema.Literal("month"),
  }),
  Schema.TaggedStruct("TopUp", {
    id: Schema.String,
    name: Schema.String,
    amount: Schema.Number,
    currency: Currency,
  }),
]);
export type Purchase = typeof Purchase.Type;

/**
 * The payment provider (Stripe), implemented by the server. The model decides who may pay for
 * what and at which price; the provider makes the customer and the hosted pages.
 */
export class Payments extends Domain.ExternalSystem(
  "Payments",
  {
    /** The organisation's customer; the same organisation always gets the same customer. */
    createCustomer: {
      args: { org: Schema.String, name: Schema.String, email: Schema.String },
      success: { customer: Schema.String },
    },
    /**
     * A hosted checkout page for one purchase by `customer`: a subscription for a plan, a
     * one-off payment for a top-up. Its payment events name `org` and the purchase's `id`.
     */
    checkout: {
      args: {
        customer: Schema.String,
        org: Schema.String,
        purchase: Purchase,
        successUrl: Schema.String,
        cancelUrl: Schema.String,
      },
      success: { url: Schema.String },
    },
    /** The provider's billing portal for `customer`: plan changes, payment methods, invoices. */
    portal: {
      args: { customer: Schema.String, returnUrl: Schema.String },
      success: { url: Schema.String },
    },
  },
  { description: "Payments (Stripe): customers, checkout pages, the billing portal." },
) {}
