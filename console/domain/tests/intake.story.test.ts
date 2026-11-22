import * as Effect from "effect/Effect";
import { Db } from "@highalch/story/tanstack-db";
import { describe, expect, it } from "vite-plus/test";
import { artifacts, billing, results, runs } from "../src/Console.collections.ts";
import { RunOpened } from "../src/Organization/OpenRun.command.ts";
import { Organization } from "../src/Organization/Organization.aggregate.ts";
import { AddArtifacts } from "../src/Run/AddArtifacts.command.ts";
import { AddResults } from "../src/Run/AddResults.command.ts";
import { ExpireRun, FinishRun } from "../src/Run/FinishRun.command.ts";
import { Run } from "../src/Run/Run.aggregate.ts";
import {
  acmeCrm,
  alice,
  apiKey,
  ask,
  bearer,
  billingProject,
  bob,
  ci,
  console,
  crm,
  everyUploadAccounted,
  existingProject,
  inModel,
  noCounts,
  openedRun,
  orgA,
  orgB,
  paidOrganization,
  periodStart,
  run1,
  runContext,
  session,
  Story,
} from "./support.ts";

const crmKey = apiKey(crm, "k1");
const betaKey = apiKey(billingProject, "k2");

const people = [
  [orgA, session(alice)],
  ["ci", bearer(crmKey.token)],
  ["beta", bearer(betaKey.token)],
] as const;

const history = [
  paidOrganization(orgA, alice),
  ...existingProject(crm, orgA, { repository: acmeCrm, keys: [crmKey] }),
];

const R1 = Run.ref(run1);
const body = { name: "a.png", mime: "image/png", bytes: 10, sha256: "a".repeat(64) };
const part = { part: "cases" as const, sha256: "e".repeat(64), bytes: 100, count: 2 };
const batch = (org = orgA) => ({
  org,
  run: run1,
  kind: "fuzz" as const,
  parts: [part],
  ...noCounts,
});
const { org: _, ...context } = runContext();

/** What `RunIntake` forwards for a results batch of run-1. */
const addResults = new AddResults({
  org: orgA,
  period: periodStart,
  parts: [{ part: "cases", key: "r/org-a/run-1/k.cases.json", count: 2, charged: 2 }],
  uploads: [],
  ...noCounts,
  bytes: 100,
});

const addArtifacts = new AddArtifacts({
  org: orgA,
  period: periodStart,
  artifacts: [{ ...body, id: "run-1.1", index: 1, upload: true, generation: 0 }],
});

describe("Run intake", () => {
  it("applies every upload CI sends back to back before completing the run", () =>
    console(people)(
      ...history,
      ask(
        "open, declare, record and complete without waiting",
        (api) =>
          Effect.all(
            [
              api.OpenRun(orgA, { ...runContext(), run: run1 }),
              api.DeclareArtifacts(orgA, { org: orgA, run: run1, artifacts: [body] }),
              api.RecordResults(orgA, batch()),
              api.CompleteRun(orgA, { org: orgA, run: run1 }),
            ],
            { concurrency: 1 },
          ),
        (receipts) => expect(receipts).toHaveLength(4),
        { as: "ci" },
      ),
      Story.settle(),
      Db.then(
        runs.get({ run: run1 }),
        ([row]) => row?.status === "completed" && row.summary.artifacts === 1 && row.bytes >= 110,
      ),
      Db.then(artifacts.list({ run: run1 }), [{ id: "run-1.1" }]),
      Db.then(results.list({ run: run1 }), (rows) => rows.some((r) => r.part === "cases")),
      everyUploadAccounted(orgA, run1, { applied: 2, dropped: 0 }),
    ));

  // The platform may deliver one organisation's steps out of order: completion overtook the
  // uploads, and the run completed without them (quota reserved, results lost).
  it("waits for every accepted upload when the completion reaches the run first", () =>
    console(people)(
      ...history,
      ...openedRun(run1),
      Story.remote(R1, new FinishRun({ org: orgA, writes: 2 })),
      Db.then(runs.get({ run: run1 }), [{ status: "running", closing: 2, applied: 0 }]),
      Story.remote(R1, addResults),
      Db.then(runs.get({ run: run1 }), [{ status: "running", applied: 1 }]),
      Story.remote(R1, addArtifacts),
      Db.then(
        runs.get({ run: run1 }),
        ([row]) =>
          row?.status === "completed" &&
          row.reason === "client" &&
          row.summary.artifacts === 1 &&
          row.bytes >= 110,
      ),
      everyUploadAccounted(orgA, run1, { applied: 2, dropped: 0 }),
    ));

  it("creates the run from an upload that reaches it before its creation", () =>
    console(people)(
      ...history,
      // the organisation admitted run-1; its creation has not reached the run yet
      Story.given(
        Organization.ref(orgA),
        new RunOpened({ run: run1, period: periodStart, ...context }),
      ),
      Story.as("ci", Db.when(ci.record, batch()), Db.settled("Committed")),
      Db.then(runs.get({ run: run1 }), [{ status: "running", applied: 1, project: crm }]),
      everyUploadAccounted(orgA, run1, { applied: 1, dropped: 0 }),
    ));

  it("gives back and records an upload of a run that expired before it arrived", () =>
    console(people)(
      ...history,
      ...openedRun(run1),
      Story.remote(R1, new ExpireRun({})),
      Db.then(runs.get({ run: run1 }), [{ status: "completed", reason: "expired" }]),
      // the organisation accepted an upload before it learnt the run expired
      Story.given(
        Organization.ref(orgA),
        new RunOpened({ run: run1, period: periodStart, ...context }),
      ),
      Story.as("ci", Db.when(ci.record, batch()), Db.settled("Committed")),
      Db.then(
        billing.get({ org: orgA }),
        ([row]) =>
          row?.droppedWrites === 1 && row.usage.resultRows === 0 && row.usage.uploadedBytes === 0,
      ),
      everyUploadAccounted(orgA, run1, { applied: 0, dropped: 1 }),
    ));

  it("gives back and records an upload to a run id another organisation holds", () =>
    console(people)(
      ...history,
      paidOrganization(orgB, bob),
      ...existingProject(billingProject, orgB, { keys: [betaKey] }),
      ...openedRun(run1),
      // org-b admitted the same id; its creation did not reach the run yet
      Story.given(
        Organization.ref(orgB),
        new RunOpened({ run: run1, period: periodStart, ...context, project: billingProject }),
      ),
      Story.as(
        "beta",
        Db.when(ci.declare, { org: orgB, run: run1, artifacts: [body] }),
        Db.settled("Committed"),
      ),
      Db.then(runs.get({ run: run1 }), [{ org: orgA, applied: 0 }]),
      Story.check("org-b got its usage back and recorded the drop", async (world) => {
        const state = await inModel(world, ({ organizations }) => organizations.get(orgB));
        expect(
          state._tag === "Active" && [
            state.droppedWrites,
            state.storedBytes,
            state.usage.artifacts,
          ],
        ).toEqual([1, 0, 0]);
      }),
    ));

  it("shows each run's commit message and author without joining commits", () =>
    console(people)(
      ...history,
      Story.as(
        "ci",
        Db.when(ci.open, {
          ...runContext(),
          run: run1,
          commitInfo: {
            message: "Add customer cards",
            author: { login: "sam", name: "Sam" },
            committedAt: "2026-11-19T10:00:00Z",
          },
        }),
        Db.settled("Committed"),
      ),
      Db.then(runs.get({ run: run1 }), [
        {
          commitInfo: {
            message: "Add customer cards",
            author: { login: "sam", name: "Sam" },
            committedAt: "2026-11-19T10:00:00Z",
          },
        },
      ]),
    ));
});
