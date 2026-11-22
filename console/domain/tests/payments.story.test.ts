import { describe, expect, it } from "vite-plus/test";
import { Db } from "@highalch/story/tanstack-db";
import { billing, organizations } from "../src/Console.collections.ts";
import { ActivatePlan } from "../src/Organization/ActivatePlan.command.ts";
import { OrganizationCreated } from "../src/Organization/CreateOrganization.command.ts";
import { Organization } from "../src/Organization/Organization.aggregate.ts";
import {
  alice,
  apiKey,
  ask,
  asServer,
  bearer,
  bob,
  console,
  crm,
  DAY,
  existingProject,
  now,
  orgA,
  refused,
  session,
  Stripe,
  Story,
} from "./support.ts";

const crmKey = apiKey(crm, "k1");

const people = [
  [orgA, session(alice)],
  ["bob", session(bob)],
  ["ci", bearer(crmKey.token)],
] as const;

const urls = { successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" };

/** Alice creates org-a; `BillingAccount` makes and links its payment customer. */
const created = [
  Db.when(organizations.create, {
    org: orgA,
    name: "Acme",
    owner: alice.id,
    ownerEmail: alice.email,
    ownerName: alice.name,
  }),
  Db.settled("Committed"),
  ...existingProject(crm, orgA, { keys: [crmKey] }),
];

const paid = asServer("an invoice was paid", ({ organizations }) =>
  organizations.send(
    orgA,
    new ActivatePlan({ plan: "starter", periodStart: now() - DAY, periodEnd: now() + 30 * DAY }),
  ),
);

describe("Payments", () => {
  it("gives every new organisation its payment customer", () =>
    console(people)(
      ...created,
      Db.then(billing.get({ org: orgA }), [{ customer: true, plan: null }]),
      Story.check("the provider made one customer for org-a", async (world) => {
        const stripe = await world.host.service?.(Stripe);
        expect([...(stripe?.customers ?? [])]).toEqual([[orgA, "cus_org-a"]]);
      }),
    ));

  it("sells the owner a plan while none is current, then top-ups, at the table's prices", () =>
    console(people)(
      ...created,
      refused(
        "a plan that does not exist",
        (api) => api.CheckoutLink({ org: orgA, purchase: { plan: "free" }, ...urls }),
        "UnknownPurchase",
      ),
      refused(
        "a top-up without a current plan",
        (api) => api.CheckoutLink({ org: orgA, purchase: { topUp: "boost" }, ...urls }),
        "NoActivePlan",
      ),
      ask(
        "a checkout for the team plan",
        (api) => api.CheckoutLink({ org: orgA, purchase: { plan: "team" }, ...urls }),
        ({ url }) => expect(url).toContain("checkout.stripe.test"),
      ),
      paid,
      refused(
        "a second plan while one is current",
        (api) => api.CheckoutLink({ org: orgA, purchase: { plan: "team" }, ...urls }),
        "AlreadySubscribed",
      ),
      ask(
        "a top-up during the paid period",
        (api) => api.CheckoutLink({ org: orgA, purchase: { topUp: "boost" }, ...urls }),
        ({ url }) => expect(url).toContain("checkout.stripe.test"),
      ),
      Story.check("each page was priced from Billing/Plan.ts", async (world) => {
        const stripe = await world.host.service?.(Stripe);
        expect(stripe?.checkouts).toEqual([
          {
            customer: "cus_org-a",
            org: orgA,
            purchase: {
              _tag: "Plan",
              id: "team",
              name: "Team",
              amount: 14_900,
              currency: "eur",
              interval: "month",
            },
          },
          {
            customer: "cus_org-a",
            org: orgA,
            purchase: {
              _tag: "TopUp",
              id: "boost",
              name: "Boost pack",
              amount: 1_900,
              currency: "eur",
            },
          },
        ]);
      }),
    ));

  it("opens the billing portal for the owner", () =>
    console(people)(
      ...created,
      ask(
        "the portal",
        (api) => api.PortalLink({ org: orgA, returnUrl: "https://app.test/billing" }),
        ({ url }) =>
          expect(url).toBe("https://billing.stripe.test/cus_org-a?then=https://app.test/billing"),
      ),
    ));

  it("serves billing pages to the organisation's owners only", () =>
    console(people)(
      ...created,
      refused(
        "another user's checkout",
        (api) => api.CheckoutLink({ org: orgA, purchase: { plan: "team" }, ...urls }),
        "NotAllowed",
        { as: "bob" },
      ),
      refused(
        "another user's portal",
        (api) => api.PortalLink({ org: orgA, returnUrl: "https://app.test" }),
        "NotAllowed",
        { as: "bob" },
      ),
      refused(
        "a project key's checkout",
        (api) => api.CheckoutLink({ org: orgA, purchase: { plan: "team" }, ...urls }),
        "NotAllowed",
        { as: "ci" },
      ),
    ));

  it("asks to retry while the organisation's customer is not linked yet", () =>
    console(people)(
      // history: the organisation exists, but its customer was never made
      Story.given(
        Organization.ref(orgA),
        new OrganizationCreated({
          name: "Acme",
          owner: alice.id,
          ownerEmail: alice.email,
          ownerName: alice.name,
        }),
      ),
      refused(
        "a checkout",
        (api) => api.CheckoutLink({ org: orgA, purchase: { plan: "team" }, ...urls }),
        "BillingAccountPending",
      ),
      refused(
        "the portal",
        (api) => api.PortalLink({ org: orgA, returnUrl: "https://app.test" }),
        "BillingAccountPending",
      ),
    ));

  it("never sends the browser back anywhere but the app", () =>
    console(people)(
      ...created,
      refused(
        "a checkout returning to another site",
        (api) =>
          api.CheckoutLink({
            org: orgA,
            purchase: { plan: "team" },
            successUrl: "https://evil.test/ok",
            cancelUrl: urls.cancelUrl,
          }),
        "ReturnUrlRefused",
      ),
      refused(
        "a portal returning to something that is no URL",
        (api) => api.PortalLink({ org: orgA, returnUrl: "javascript:alert(1)" }),
        "ReturnUrlRefused",
      ),
      Story.check("no page was made", async (world) => {
        const stripe = await world.host.service?.(Stripe);
        expect(stripe?.checkouts).toEqual([]);
      }),
    ));
});
