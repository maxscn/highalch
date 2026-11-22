import * as Stripe from "@alchemy.run/stripe";
import { withRequestOptions } from "@distilled.cloud/stripe";
import { Payments, type Purchase } from "@highalch/console-domain/Payments.external";

export { Payments };
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ambient } from "./Ambient.ts";
import { ServerConfig } from "./ServerConfig.ts";

/** Stripe answered a checkout without a page to send the customer to. */
export class CheckoutWithoutUrl extends Schema.TaggedError<CheckoutWithoutUrl>()(
  "CheckoutWithoutUrl",
  {},
) {}

/** What every Stripe object of a purchase carries, so payment events find their way back. */
export const purchaseMetadata = (org: string, purchase: Purchase) => ({
  org,
  purchase: purchase.id,
});

/** Checkout line items priced inline from the plan table (no Stripe price objects to keep in sync). */
const lineItem = (purchase: Purchase) => ({
  quantity: 1,
  price_data: {
    currency: purchase.currency,
    unit_amount: purchase.amount,
    product_data: { name: `HighAlch Console ${purchase.name}` },
    ...(purchase._tag === "Plan" ? { recurring: { interval: purchase.interval } } : {}),
  },
});

/**
 * The domain's `Payments` over Stripe (`@alchemy.run/stripe` bindings, deployed only): one
 * customer per organisation (idempotency key `customer:<org>`), Checkout for a plan
 * (subscription) or a top-up (one-off payment) with `org` and the purchase id on the session and
 * on its subscription or payment intent, and the billing portal. Return URLs were checked by the
 * domain (`ReturnUrlRefused`); Stripe failing is a defect (the query answers 500).
 */
export const stripe = Payments.toLayer(
  Effect.gen(function* () {
    const createCustomer = yield* Stripe.CreateCustomer();
    const createCheckout = yield* Stripe.CreateCheckoutSession();
    const createPortal = yield* Stripe.CreateBillingPortalSession();
    return {
      createCustomer: Effect.fn("Payments.createCustomer")(
        function* ({ org, name, email }) {
          const customer = yield* createCustomer({ name, email, metadata: { org } }).pipe(
            withRequestOptions({ idempotencyKey: `customer:${org}` }),
          );
          return { customer: customer.id };
        },
        ambient,
        Effect.orDie,
      ),
      checkout: Effect.fn("Payments.checkout")(
        function* ({ customer, org, purchase, successUrl, cancelUrl }) {
          const metadata = purchaseMetadata(org, purchase);
          const session = yield* createCheckout({
            customer,
            client_reference_id: org,
            mode: purchase._tag === "Plan" ? "subscription" : "payment",
            line_items: [lineItem(purchase)],
            success_url: successUrl,
            cancel_url: cancelUrl,
            allow_promotion_codes: false,
            metadata,
            ...(purchase._tag === "Plan"
              ? { subscription_data: { metadata } }
              : { payment_intent_data: { metadata } }),
          } as Parameters<typeof createCheckout>[0]);
          if (typeof session.url !== "string") return yield* new CheckoutWithoutUrl();
          return { url: session.url };
        },
        ambient,
        Effect.orDie,
      ),
      portal: Effect.fn("Payments.portal")(
        function* ({ customer, returnUrl }) {
          const session = yield* createPortal({
            customer,
            return_url: returnUrl,
          });
          return { url: session.url };
        },
        ambient,
        Effect.orDie,
      ),
    };
  }),
);

/**
 * Payments under `alchemy dev`: no Stripe account is touched. Customers are `cus_local_<org>`;
 * checkout and portal pages are the app's own origin with what would have been bought, so a
 * developer sees the flow end where Stripe would take over. Plans are activated locally by
 * delivering a signed Stripe event to the webhook (see `scripts/` and the Worker tests).
 */
export const local = Payments.toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const page = (path: string, params: Record<string, string>) =>
      `${new URL(path, config.appOrigin).toString()}?${new URLSearchParams(params).toString()}`;
    return {
      createCustomer: ({ org }) => Effect.succeed({ customer: `cus_local_${org}` }),
      checkout: ({ org, purchase, successUrl }) =>
        Effect.succeed({
          url: page("/local/checkout", { org, purchase: purchase.id, next: successUrl }),
        }),
      portal: ({ customer, returnUrl }) =>
        Effect.succeed({ url: page("/local/portal", { customer, next: returnUrl }) }),
    };
  }),
);
