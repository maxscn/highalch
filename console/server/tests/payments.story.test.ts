import { Internals } from "@alchemy.run/domain/Model";
import * as Story from "@highalch/story";
import { LowAlchDb } from "@highalch/story/lowalch";
import {
  CallerLive,
  GithubOidc,
  Sessions,
  type SessionUser,
} from "@highalch/console-domain/Authentication";
import { AppOrigin } from "@highalch/console-domain/AppOrigin";
import { Caller } from "@highalch/console-domain/Caller.middleware";
import { ConsoleApi } from "@highalch/console-domain/Console.api";
import { ConsoleHandlers } from "@highalch/console-domain/Console.model";
import { sessionCookie } from "@highalch/console-domain/Credentials";
import { UserId } from "@highalch/console-domain/Ids";
import { PlanActivated } from "@highalch/console-domain/Organization/ActivatePlan.command";
import { OrganizationCreated } from "@highalch/console-domain/Organization/CreateOrganization.command";
import { CustomerLinked } from "@highalch/console-domain/Organization/LinkCustomer.command";
import { Organization } from "@highalch/console-domain/Organization/Organization.aggregate";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { Payments } from "@highalch/console-domain/Payments.external";
import { Storage } from "@highalch/console-domain/Storage.external";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import { onPaymentEvent, type PaymentEvent } from "../src/PaymentEvents.ts";

/**
 * Stripe's payment events, as the Worker's webhook hands them to the model: stories over the
 * Console in memory (its real handlers and `CallerLive`), where the owner reads the billing row
 * the events produce.
 */

const DAY = 86_400_000;
const org = OrganizationId.make("org-pay");
const owner: SessionUser = { id: UserId.make("u-owner"), email: "o@example.com", name: "O" };
const customer = "cus_pay";

const services = () =>
  Layer.mergeAll(
    Storage.toLayer(
      Effect.succeed({
        inspect: () => Effect.succeed({ status: "missing" as const }),
        readItems: () => Effect.succeed({ items: [], total: 0 }),
        writeJson: () => Effect.succeed({ bytes: 0 }),
        remove: () => Effect.succeed({}),
        presignPut: () => Effect.succeed({ url: "memory://put", headers: {} }),
        presignGet: () => Effect.succeed({ url: "memory://get" }),
      }),
    ),
    Payments.toLayer(
      Effect.succeed({
        createCustomer: () => Effect.succeed({ customer }),
        checkout: () => Effect.succeed({ url: "https://checkout.test" }),
        portal: () => Effect.succeed({ url: "https://portal.test" }),
      }),
    ),
    Layer.succeed(Sessions, {
      user: (token) =>
        Effect.succeed(Redacted.value(token) === "s-owner" ? Option.some(owner) : Option.none()),
    }),
    Layer.succeed(GithubOidc, { verify: () => Effect.succeed(Option.none()) }),
    Layer.succeed(AppOrigin, { origin: "https://console.test" }),
    Digest.layerWebCrypto,
  );

/** Every scope is the owner's browser. */
const session = () =>
  Layer.effect(
    Caller,
    Effect.map(
      Effect.service(Caller),
      (live) => (effect, options) =>
        live(effect, {
          ...options,
          headers: Headers.fromInput({ cookie: `${sessionCookie}=s-owner` }),
        }),
    ),
  ).pipe(Layer.provide(CallerLive));

const story = Story.make(
  LowAlchDb.memory({
    api: ConsoleApi,
    layer: () => ConsoleHandlers,
    services,
    // SAFETY: the session runs on the host's context: the model and the identity providers.
    session: () => session() as unknown as Layer.Layer<Caller>,
  }),
  { scope: org },
);

/** History: the owner's organisation, its Stripe customer linked. */
const linked = Story.given(
  Organization.ref(org),
  new OrganizationCreated({
    name: "Pay",
    owner: owner.id,
    ownerEmail: owner.email,
    ownerName: owner.name,
  }),
  new CustomerLinked({ customer }),
);

/** Stripe delivers a verified event; the webhook runs it against the hosted model. */
const stripe = (label: string, event: PaymentEvent) =>
  Story.step(`Stripe delivers ${label}`, async (world) => {
    const internals = await world.host.service?.(Internals);
    if (!internals) throw new Error("this host has no model");
    await Effect.runPromise(
      // SAFETY: one service under two types. This package resolves its own copy of
      // `@alchemy.run/domain` (with the Cloudflare peer its Worker needs), the model the
      // workspace's; `Internals` is the same key in both, so providing it satisfies the model.
      onPaymentEvent(event).pipe(
        Effect.provideService(Internals, internals),
      ) as Effect.Effect<void>,
    );
    await world.settle();
  });

/** The owner reads the organisation's billing row. */
const billing = (label: string, check: (row: unknown) => void) =>
  Story.step(`the owner sees ${label}`, async (world) => {
    const api = (await world.raw(world.scope)) as unknown as typeof ConsoleApi.Client.Service;
    check(await Effect.runPromise(api.Billing({ org })));
  });

const now = Date.now();
const invoice = (overrides: Record<string, unknown> = {}) => ({
  type: "invoice.paid",
  object: {
    id: "in_1",
    status: "paid",
    currency: "eur",
    amount_paid: 5_900,
    customer,
    parent: { subscription_details: { metadata: { org, purchase: "starter" } } },
    lines: { data: [{ period: { start: now / 1000 - 60, end: now / 1000 + 30 * 86_400 } }] },
    ...overrides,
  },
});

describe("Stripe payment events", () => {
  it("activates the plan a paid subscription invoice names", () =>
    story.with({ name: "invoice.paid activates the plan" })(
      linked,
      stripe("invoice.paid for starter", invoice()),
      billing("the starter plan", (row) =>
        expect(row).toMatchObject({ plan: "starter", suspended: null }),
      ),
    ));

  it("ignores an invoice that is not fully paid, or for an unknown plan", () =>
    story.with({ name: "unpaid invoices change nothing" })(
      linked,
      stripe("an underpaid invoice", invoice({ amount_paid: 100 })),
      stripe(
        "an unknown plan",
        invoice({
          id: "in_2",
          parent: { subscription_details: { metadata: { org, purchase: "gold" } } },
        }),
      ),
      stripe("a draft invoice", invoice({ id: "in_3", status: "open" })),
      billing("no plan", (row) => expect(row).toMatchObject({ plan: null })),
    ));

  it("suspends uploads when a payment is refunded", () =>
    story.with({ name: "a refund suspends" })(
      linked,
      Story.given(
        Organization.ref(org),
        new PlanActivated({
          plan: "starter",
          periodStart: now - DAY,
          periodEnd: now + 30 * DAY,
          liftsSuspension: false,
        }),
      ),
      stripe("charge.refunded", { type: "charge.refunded", object: { id: "ch_1", customer } }),
      billing("the plan suspended", (row) =>
        expect(row).toMatchObject({ plan: "starter", suspended: "refunded" }),
      ),
    ));

  it("credits a top-up a paid one-off checkout names", () =>
    story.with({ name: "a paid checkout credits a top-up" })(
      linked,
      Story.given(
        Organization.ref(org),
        new PlanActivated({
          plan: "starter",
          periodStart: now - DAY,
          periodEnd: now + 30 * DAY,
          liftsSuspension: false,
        }),
      ),
      stripe("checkout.session.completed", {
        type: "checkout.session.completed",
        object: {
          id: "cs_1",
          mode: "payment",
          payment_status: "paid",
          currency: "eur",
          amount_total: 1_900,
          metadata: { org, purchase: "boost" },
        },
      }),
      billing("the boost added to the limits", (row) => {
        const limits = (row as { readonly limits: { readonly artifactsPerPeriod: number } }).limits;
        expect(limits.artifactsPerPeriod).toBeGreaterThan(5_000);
      }),
    ));
});
