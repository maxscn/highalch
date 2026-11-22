import { describe, it } from "vite-plus/test";
import { Db } from "@highalch/story/tanstack-db";
import { GB, MB } from "../src/Billing/Plan.ts";
import { billing } from "../src/Console.collections.ts";
import { NotAllowed } from "../src/NotAllowed.rejection.ts";
import { ActivatePlan, PlanActivated } from "../src/Organization/ActivatePlan.command.ts";
import { billingStatus } from "../src/Organization/Billing.ts";
import { OrganizationCreated } from "../src/Organization/CreateOrganization.command.ts";
import { CreditTopUp } from "../src/Organization/CreditTopUp.command.ts";
import { NotEntitled } from "../src/Organization/NotEntitled.rejection.ts";
import { Organization } from "../src/Organization/Organization.aggregate.ts";
import { QuotaExceeded } from "../src/Organization/QuotaExceeded.rejection.ts";
import { ReleaseUsage } from "../src/Organization/ReleaseUsage.command.ts";
import { UsageReserved } from "../src/Organization/UsageReserved.event.ts";
import { ResumeBilling, SuspendBilling } from "../src/Organization/SuspendBilling.command.ts";
import { RunId } from "../src/Run/Run.id.ts";
import {
  acmeCrm,
  alice,
  apiKey,
  asServer,
  bearer,
  billingProject,
  bob,
  console,
  crm,
  DAY,
  existingProject,
  ci,
  noCounts,
  openedRun,
  periodStart,
  runContext,
  now,
  orgA,
  orgB,
  run1,
  run2,
  session,
  Story,
} from "./support.ts";

const crmKey = apiKey(crm, "k1");
const betaKey = apiKey(billingProject, "k2");

/** Alice watches org-a's billing; CI uploads with crm's key (`ci`) or its GitHub OIDC token (`gh`). */
const people = [
  [orgA, session(alice)],
  ["ci", bearer(crmKey.token)],
  ["gh", bearer("gh-main")],
  ["beta", bearer(betaKey.token)],
] as const;

const A = Organization.ref(orgA);

const created = new OrganizationCreated({
  name: "Acme",
  owner: alice.id,
  ownerEmail: alice.email,
  ownerName: alice.name,
});

/** The paid period the stories start in: it began yesterday and runs for 30 days. */
const start = periodStart;
const end = start + 31 * DAY;
const period = { plan: "starter", periodStart: start, periodEnd: end };
const paid = new PlanActivated({ ...period, liftsSuspension: false });

const projects = [
  ...existingProject(crm, orgA, { repository: acmeCrm, keys: [crmKey] }),
  ...existingProject(billingProject, orgB, { keys: [betaKey] }),
];

/** CI's declaration of `count` artifacts of `size` bytes (20 MB each by default) for run-1. */
const artifacts = (count: number, size = 20 * MB, org = orgA) => ({
  org,
  run: run1,
  artifacts: Array.from({ length: count }, (_, n) => ({
    name: `${n}.png`,
    mime: "image/png",
    bytes: size,
    sha256: (n + 1).toString(16).padStart(64, "0"),
  })),
});

/** CI's opening of `run` in `org` (crm's in org-a, billing's in org-b). */
const opening = (run: RunId, org = orgA) => ({
  ...runContext({ org, project: org === orgA ? crm : billingProject }),
  run,
});

/** A results batch of run-1 with `rows` items in one object. */
const rows = (count: number) => ({
  org: orgA,
  run: run1,
  kind: "fuzz" as const,
  parts: [{ part: "cases" as const, sha256: "f".repeat(64), bytes: 1_000, count }],
  ...noCounts,
});

const usage = (uploaded: number, stored = uploaded) =>
  Db.then(
    billing.get({ org: orgA }),
    ([row]) => row?.usage.uploadedBytes === uploaded && row.usage.storedBytes === stored,
  );

describe("Billing entitlement", () => {
  it("activates from a verified payment and ignores a replayed or older webhook", () =>
    console(people).with({ rules: Db.rules })(
      Story.given(A, created),
      Db.then(billing.get({ org: orgA }), [{ plan: null, periodEnd: null, suspended: null }]),
      asServer("an invoice was paid", ({ organizations }) =>
        organizations.send(orgA, new ActivatePlan(period), { commandId: "evt_1" }),
      ),
      Db.then(
        billing.get({ org: orgA }),
        ([row]) =>
          row?.plan === "starter" &&
          row.periodEnd === end &&
          row.limits?.storedBytes === 10 * GB &&
          billingStatus(row, now()) === "active",
      ),
      asServer("the same event again", ({ organizations }) =>
        organizations.send(orgA, new ActivatePlan(period), { commandId: "evt_1" }),
      ),
      asServer("the same invoice as another event", ({ organizations }) =>
        organizations.send(orgA, new ActivatePlan(period), { commandId: "evt_2" }),
      ),
      asServer("an older invoice", ({ organizations }) =>
        organizations.send(orgA, new ActivatePlan({ ...period, periodEnd: start + DAY }), {
          commandId: "evt_0",
        }),
      ),
      Db.then(billing.get({ org: orgA }), [{ plan: "starter", periodEnd: end }]),
    ));

  it("fails closed once the paid period has ended without a renewal", () =>
    console(people)(
      Story.given(
        A,
        created,
        new PlanActivated({
          plan: "starter",
          periodStart: start - 31 * DAY,
          periodEnd: start,
          liftsSuspension: false,
        }),
      ),
      ...projects,
      ...openedRun(run1),
      Db.then(
        billing.get({ org: orgA }),
        ([row]) => row !== undefined && billingStatus(row, now()) === "lapsed",
      ),
      Story.as(
        "ci",
        Db.when(ci.declare, artifacts(1, 1)),
        Db.rejected(new NotEntitled({ reason: "no_entitlement" })),
        Db.when(ci.open, opening(run2)),
        Db.rejected(new NotEntitled({ reason: "no_entitlement" })),
      ),
    ));

  it("renews into a fresh period with fresh usage", () =>
    console(people)(
      Story.given(
        A,
        created,
        paid,
        new UsageReserved({ run: run1, period: start, bytes: 19_800 * MB, artifacts: 5, rows: 0 }),
      ),
      ...projects,
      ...openedRun(run1),
      usage(19_800 * MB),
      Story.as(
        "ci",
        Db.when(ci.declare, artifacts(20)),
        Db.rejected(
          new QuotaExceeded({
            limit: "storedBytes",
            max: 10 * GB,
            used: 19_800 * MB,
            requested: 400 * MB,
          }),
        ),
      ),
      asServer("retention deleted 15 GB", ({ organizations }) =>
        organizations.send(
          orgA,
          new ReleaseUsage({
            run: run1,
            bytes: 15 * GB,
            artifacts: 0,
            rows: 0,
            period: null,
            reason: "retention",
          }),
        ),
      ),
      usage(19_800 * MB, 4_800 * MB),
      Story.as(
        "ci",
        Db.when(ci.declare, artifacts(20)),
        Db.rejected(
          new QuotaExceeded({
            limit: "uploadedBytesPerPeriod",
            max: 20 * GB,
            used: 19_800 * MB,
            requested: 400 * MB,
          }),
        ),
      ),
      asServer("the renewal was paid", ({ organizations }) =>
        organizations.send(
          orgA,
          new ActivatePlan({ plan: "starter", periodStart: end, periodEnd: end + 30 * DAY }),
        ),
      ),
      usage(0, 4_800 * MB),
      Story.as("ci", Db.when(ci.declare, artifacts(20)), Db.settled("Committed")),
      usage(400 * MB, 5_200 * MB),
    ));

  it("suspends on a failed renewal, a refund or a dispute; a paid invoice lifts only the first", () =>
    console(people)(
      Story.given(A, created, paid),
      ...projects,
      ...openedRun(run1),
      asServer("a renewal failed", ({ organizations }) =>
        organizations.send(orgA, new SuspendBilling({ reason: "payment_failed" })),
      ),
      Db.then(
        billing.get({ org: orgA }),
        ([row]) => row?.suspended === "payment_failed" && billingStatus(row, now()) === "suspended",
      ),
      Story.as(
        "ci",
        Db.when(ci.declare, artifacts(1, 1)),
        Db.rejected(new NotEntitled({ reason: "suspended" })),
      ),
      asServer("the invoice was paid after all", ({ organizations }) =>
        organizations.send(
          orgA,
          new ActivatePlan({ ...period, periodStart: start, periodEnd: end + DAY }),
        ),
      ),
      Db.then(billing.get({ org: orgA }), [{ suspended: null }]),
      asServer("a charge was disputed", ({ organizations }) =>
        organizations.send(orgA, new SuspendBilling({ reason: "disputed" })),
      ),
      asServer("the next invoice was paid", ({ organizations }) =>
        organizations.send(
          orgA,
          new ActivatePlan({ ...period, periodStart: end, periodEnd: end + 30 * DAY }),
        ),
      ),
      Db.then(billing.get({ org: orgA }), [{ suspended: "disputed" }]),
      Story.as(
        "ci",
        Db.when(ci.declare, artifacts(1, 1)),
        Db.rejected(new NotEntitled({ reason: "suspended" })),
      ),
      asServer("a refund is no dispute", ({ organizations }) =>
        organizations.send(orgA, new ResumeBilling({ reason: "refunded" })),
      ),
      Db.then(billing.get({ org: orgA }), [{ suspended: "disputed" }]),
      asServer("the dispute was won", ({ organizations }) =>
        organizations.send(orgA, new ResumeBilling({ reason: "disputed" })),
      ),
      Db.then(billing.get({ org: orgA }), [{ suspended: null }]),
      Story.as("ci", Db.when(ci.declare, artifacts(1, 1)), Db.settled("Committed")),
    ));

  it("credits a top-up to the current period only, from the server only", () =>
    console(people)(
      Story.given(
        A,
        created,
        paid,
        new UsageReserved({ run: run1, period: start, bytes: 9 * GB, artifacts: 5_000, rows: 0 }),
      ),
      ...projects,
      ...openedRun(run1),
      Story.as(
        "ci",
        Db.when(ci.declare, artifacts(1, 1)),
        Db.rejected(
          new QuotaExceeded({ limit: "artifactsPerPeriod", max: 5_000, used: 5_000, requested: 1 }),
        ),
      ),
      asServer("a top-up was paid", ({ organizations }) =>
        organizations.send(orgA, new CreditTopUp({ topUp: "boost" }), { commandId: "cs_1" }),
      ),
      asServer("the same payment again", ({ organizations }) =>
        organizations.send(orgA, new CreditTopUp({ topUp: "boost" }), { commandId: "cs_1" }),
      ),
      Db.then(billing.get({ org: orgA }), ([row]) => row?.limits?.artifactsPerPeriod === 7_000),
      Story.as("ci", Db.when(ci.declare, artifacts(1, 1)), Db.settled("Committed")),
    ));
});

describe("Quota", () => {
  it("never lets two reservations exceed a cap together", () =>
    console(people)(
      Story.given(
        A,
        created,
        paid,
        new UsageReserved({ run: run1, period: start, bytes: 9_500 * MB, artifacts: 0, rows: 0 }),
      ),
      ...projects,
      ...openedRun(run1),
      Story.as("ci", Db.when(ci.declare, artifacts(20)), Db.settled("Committed")),
      Story.as(
        "gh",
        Db.when(ci.declare, artifacts(20)),
        Db.rejected(
          new QuotaExceeded({
            limit: "storedBytes",
            max: 10 * GB,
            used: 9_900 * MB,
            requested: 400 * MB,
          }),
        ),
      ),
      usage(9_900 * MB),
    ));

  it("refuses an artifact larger than the plan allows, and results beyond the row cap", () =>
    console(people)(
      Story.given(A, created, paid),
      ...projects,
      ...openedRun(run1),
      Story.as(
        "ci",
        Db.when(ci.declare, artifacts(1, 26 * MB)),
        Db.rejected(
          new QuotaExceeded({
            limit: "maxArtifactBytes",
            max: 25 * MB,
            used: 0,
            requested: 26 * MB,
          }),
        ),
        Db.when(ci.record, rows(100_001)),
        Db.rejected(
          new QuotaExceeded({
            limit: "resultRowsPerPeriod",
            max: 100_000,
            used: 0,
            requested: 100_001,
          }),
        ),
        Db.when(ci.record, rows(10)),
        Db.settled("Committed"),
      ),
      Db.then(
        billing.get({ org: orgA }),
        ([row]) =>
          // a batch counts at least `minRowsPerBatch` rows
          row?.usage.resultRows === 50 && row.usage.uploadedBytes === 1_000,
      ),
    ));

  it("caps open runs", () =>
    console(people)(
      Story.given(A, created, paid),
      ...projects,
      Story.as(
        "ci",
        ...[1, 2, 3, 4, 5].flatMap((n) => [
          Db.when(ci.open, opening(RunId.make(`r${n}`))),
          Db.settled("Committed"),
        ]),
        Db.when(ci.open, opening(RunId.make("r6"))),
        Db.rejected(new QuotaExceeded({ limit: "activeRuns", max: 5, used: 5, requested: 1 })),
      ),
      Db.then(billing.get({ org: orgA }), ([row]) => row?.usage.activeRuns === 5),
    ));

  it("never spends one organisation's quota from another's key", () =>
    console(people)(
      Story.given(A, created, paid),
      Story.given(
        Organization.ref(orgB),
        new OrganizationCreated({
          name: "Beta",
          owner: bob.id,
          ownerEmail: bob.email,
          ownerName: null,
        }),
      ),
      ...projects,
      ...openedRun(run1),
      Story.as(
        "beta",
        Db.when(ci.declare, artifacts(1, 1)),
        Db.rejected(new NotAllowed()),
        Db.when(ci.open, { ...opening(run2), project: billingProject }),
        Db.rejected(new NotAllowed()),
        Db.when(ci.open, opening(run2, orgB)),
        Db.rejected(new NotEntitled({ reason: "no_entitlement" })),
      ),
      usage(0),
    ));
});
