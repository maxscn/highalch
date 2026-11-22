import { describe, expect, it } from "vite-plus/test";
import { Db } from "@highalch/story/tanstack-db";
import { billing, results, runs, subjects } from "../src/Console.collections.ts";
import { QuotaExceeded } from "../src/Organization/QuotaExceeded.rejection.ts";
import { UsageReserved } from "../src/Organization/UsageReserved.event.ts";
import { Organization } from "../src/Organization/Organization.aggregate.ts";
import { resultKey } from "../src/Run/Run.values.ts";
import {
  acmeCrm,
  alice,
  apiKey,
  bearer,
  ci,
  console,
  crm,
  existingProject,
  noCounts,
  objectsOf,
  openedRun,
  orgA,
  paidOrganization,
  periodStart,
  run1,
  session,
  Story,
} from "./support.ts";

const crmKey = apiKey(crm, "k1");

const people = [
  [orgA, session(alice)],
  ["ci", bearer(crmKey.token)],
] as const;

const history = [
  paidOrganization(orgA, alice),
  ...existingProject(crm, orgA, { repository: acmeCrm, keys: [crmKey] }),
  ...openedRun(run1),
];

const digest = "d".repeat(64);
const key = resultKey(orgA, run1, { part: "cases", sha256: digest });

/** A batch of one results object of `bytes`, claiming `count` items. */
const batch = (bytes: number, count: number) => ({
  org: orgA,
  run: run1,
  kind: "fuzz" as const,
  parts: [{ part: "cases" as const, sha256: digest, bytes, count }],
  ...noCounts,
});

/** A fuzz case of the `customer/Card` component, as comparison decodes it. */
const item = (index: number) => ({
  name: "cards",
  subject: { kind: "component", name: "customer/Card" },
  schemaHash: "s1",
  case: { id: `c${index}`, seed: 1, index, outcome: "ok" },
});

const rowsUsed = (rows: number) =>
  Db.then(billing.get({ org: orgA }), ([row]) => row?.usage.resultRows === rows);

describe("Result rows are charged by what objects can hold", () => {
  it("charges an under-reported batch by its bytes", () =>
    console(people)(
      ...history,
      Story.as("ci", Db.when(ci.record, batch(1_000_000, 0)), Db.settled("Committed")),
      // ceil(1 000 000 / minBytesPerRow 1 024) rows, not the 0 reported (nor the 50 per batch)
      rowsUsed(977),
      Db.then(results.list({ run: run1 }), [{ key, count: 0, charged: 977 }]),
    ));

  it("refuses a batch whose bytes alone exceed what the period has left", () =>
    console(people)(
      paidOrganization(orgA, alice),
      Story.given(
        Organization.ref(orgA),
        new UsageReserved({ run: run1, period: periodStart, bytes: 0, artifacts: 0, rows: 99_500 }),
      ),
      ...existingProject(crm, orgA, { repository: acmeCrm, keys: [crmKey] }),
      ...openedRun(run1),
      Story.as(
        "ci",
        Db.when(ci.record, batch(1_000_000, 1)),
        Db.rejected(
          new QuotaExceeded({
            limit: "resultRowsPerPeriod",
            max: 100_000,
            used: 99_500,
            requested: 977,
          }),
        ),
        Db.when(ci.record, batch(1_000, 1)),
        Db.settled("Committed"),
      ),
      rowsUsed(99_550),
    ));

  it("compares no more items of an object than were charged, records the rest, gives nothing back", () =>
    console(people)(
      ...history,
      // two items claimed in 232 bytes: two rows charged (the batch minimum makes it 50)
      Story.as("ci", Db.when(ci.record, batch(232, 2)), Db.settled("Committed")),
      Story.check("the object CI uploaded holds five items", async (world) => {
        const objects = await objectsOf(world);
        objects.json.set(key, [0, 1, 2, 3, 4].map(item));
      }),
      Db.then(results.list({ run: run1 }), [{ key, count: 2, charged: 2 }]),
      Story.as("ci", Db.when(ci.complete, { org: orgA, run: run1 }), Db.settled("Committed")),
      Db.then(runs.get({ run: run1 }), [{ compared: true, truncated: 3 }]),
      Db.then(subjects.list({ project: crm }), ([subject]) => subject?.latest.items === 2),
      Story.check("storage was asked for two items only", async (world) => {
        const objects = await objectsOf(world);
        expect(objects.reads).toEqual([{ key, limit: 2 }]);
      }),
      rowsUsed(50),
    ));
});
