import { findPlan, findTopUp } from "@highalch/console-domain/Billing/Plan";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { systemApi } from "./System.ts";

/** A verified Stripe event (alchemy's `Stripe.consumeEvents` checks the signature). */
export interface PaymentEvent {
  readonly type: string;
  readonly object: unknown;
}

/** Stripe event types alchemy's typed event classes do not cover; same shape. */
const event = <T extends string>(type: T) =>
  class {
    static readonly type = type;
    readonly type = type;
    constructor(readonly object: unknown) {}
  };
export const ChargeRefunded = event("charge.refunded");
export const ChargeDisputeCreated = event("charge.dispute.created");
export const ChargeDisputeClosed = event("charge.dispute.closed");
export const CheckoutAsyncPaymentSucceeded = event("checkout.session.async_payment_succeeded");

// ---------------------------------------------------------------- the Stripe objects read

const Metadata = Schema.Struct({
  org: Schema.optionalKey(Schema.String),
  purchase: Schema.optionalKey(Schema.String),
});

const Invoice = Schema.Struct({
  id: Schema.String,
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  currency: Schema.String,
  amount_paid: Schema.Number,
  customer: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parent: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        subscription_details: Schema.optionalKey(
          Schema.NullOr(Schema.Struct({ metadata: Schema.optionalKey(Schema.NullOr(Metadata)) })),
        ),
      }),
    ),
  ),
  subscription_details: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ metadata: Schema.optionalKey(Schema.NullOr(Metadata)) })),
  ),
  lines: Schema.Struct({
    data: Schema.Array(
      Schema.Struct({ period: Schema.Struct({ start: Schema.Number, end: Schema.Number }) }),
    ),
  }),
});

const CheckoutSession = Schema.Struct({
  id: Schema.String,
  mode: Schema.String,
  payment_status: Schema.String,
  currency: Schema.NullOr(Schema.String),
  amount_total: Schema.NullOr(Schema.Number),
  metadata: Schema.optionalKey(Schema.NullOr(Metadata)),
});

const ByCustomer = Schema.Struct({
  id: Schema.String,
  customer: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const Dispute = Schema.Struct({ id: Schema.String, status: Schema.String });

// ---------------------------------------------------------------- the adapter

const ignore = (type: string, reason: string) =>
  Effect.logWarning("stripe event ignored").pipe(Effect.annotateLogs({ type, reason }));

/**
 * Anti-corruption layer from Stripe to the model, through `ConsoleSystemApi`: only a verified,
 * fully paid event moves entitlement. `invoice.paid` activates a period of the plan its
 * subscription's metadata names, a paid one-off Checkout credits the top-up it names, failed
 * renewals and refunds suspend. Amounts and currencies are checked against the plan table;
 * anything unexpected is logged and ignored (fails closed). Command ids derive from the Stripe
 * object, so redelivery and replay change nothing.
 *
 * Disputes carry only their charge, and alchemy's Stripe package has no charge lookup: they are
 * logged and ignored until it has one (a known gap, as before).
 */
export const onPaymentEvent = Effect.fn("onPaymentEvent")(
  function* (event: PaymentEvent) {
    const api = yield* systemApi("stripe-webhook");
    const decode = <S extends Schema.Top>(schema: S) =>
      Schema.decodeUnknownEffect(schema)(event.object) as Effect.Effect<
        S["Type"],
        Schema.SchemaError
      >;
    const orgOfCustomer = (customer: string | null | undefined) =>
      customer
        ? Effect.map(api.CustomerOrganization.get(customer), (view) =>
            Option.fromNullishOr(view?.org),
          )
        : Effect.succeed(Option.none<OrganizationId>());

    switch (event.type) {
      case "invoice.paid": {
        const invoice = yield* decode(Invoice);
        const metadata =
          invoice.parent?.subscription_details?.metadata ??
          invoice.subscription_details?.metadata ??
          {};
        const plan = findPlan(metadata.purchase ?? "");
        const line = invoice.lines.data[0];
        if (plan === undefined) return yield* ignore(event.type, "unknown plan");
        if (metadata.org === undefined) return yield* ignore(event.type, "no organisation");
        if (
          invoice.status !== "paid" ||
          invoice.currency !== plan.price.currency ||
          !(invoice.amount_paid >= plan.price.amount)
        )
          return yield* ignore(event.type, "not fully paid");
        if (line === undefined || !(line.period.end > line.period.start))
          return yield* ignore(event.type, "no period");
        const org = OrganizationId.make(metadata.org);
        yield* api.ActivatePlan(
          org,
          {
            plan: plan.id,
            periodStart: line.period.start * 1000,
            periodEnd: line.period.end * 1000,
          },
          { commandId: `stripe:invoice.paid:${invoice.id}` },
        );
        return;
      }
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = yield* decode(CheckoutSession);
        // subscriptions are activated by their invoice
        if (session.mode !== "payment") return;
        const topUp = findTopUp(session.metadata?.purchase ?? "");
        const org = session.metadata?.org;
        if (session.payment_status !== "paid") return yield* ignore(event.type, "not paid yet");
        if (topUp === undefined || org === undefined)
          return yield* ignore(event.type, "unknown top-up");
        if (
          session.currency !== topUp.price.currency ||
          !((session.amount_total ?? 0) >= topUp.price.amount)
        )
          return yield* ignore(event.type, "not fully paid");
        // one credit per Checkout session, whichever event arrives first
        yield* api.CreditTopUp(
          OrganizationId.make(org),
          { topUp: topUp.id },
          { commandId: `stripe:checkout:${session.id}` },
        );
        return;
      }
      case "invoice.payment_failed":
      case "charge.refunded": {
        const object = yield* decode(ByCustomer);
        const org = yield* orgOfCustomer(object.customer);
        if (Option.isNone(org)) return yield* ignore(event.type, "unknown organisation");
        yield* api.SuspendBilling(
          org.value,
          { reason: event.type === "invoice.payment_failed" ? "payment_failed" : "refunded" },
          { commandId: `stripe:${event.type}:${object.id}` },
        );
        return;
      }
      case "charge.dispute.created":
      case "charge.dispute.closed": {
        const dispute = yield* decode(Dispute);
        return yield* ignore(event.type, `dispute ${dispute.id} has no customer to match`);
      }
      default:
        return yield* ignore(event.type, "not handled");
    }
  },
  Effect.scoped,
  // a malformed Stripe object or a model that does not answer fails the delivery: Stripe redelivers
  Effect.orDie,
);
