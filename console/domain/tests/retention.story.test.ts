import * as Effect from "effect/Effect";
import { Db } from "@highalch/story/tanstack-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Blob } from "../src/Blob/Blob.aggregate.ts";
import { blobId, objectKey } from "../src/Blob/Blob.id.ts";
import { BlobStored } from "../src/Blob/ConfirmBlob.command.ts";
import { BlobUploadIssued, ReferenceBlob } from "../src/Blob/ReferenceBlob.command.ts";
import { billing, runs } from "../src/Console.collections.ts";
import { PlanActivated } from "../src/Organization/ActivatePlan.command.ts";
import { StorageCharged } from "../src/Organization/ChargeStorage.command.ts";
import { OrganizationCreated } from "../src/Organization/CreateOrganization.command.ts";
import { Organization } from "../src/Organization/Organization.aggregate.ts";
import { UsageReserved } from "../src/Organization/UsageReserved.event.ts";
import { ArtifactsAccepted } from "../src/Organization/DeclareArtifacts.command.ts";
import { ResultsAccepted } from "../src/Organization/RecordResults.command.ts";
import { SweepRetention } from "../src/Organization/SweepRetention.command.ts";
import { RunCompleted } from "../src/Run/FinishRun.command.ts";
import { RunCreated } from "../src/Run/CreateRun.command.ts";
import { ArtifactsDeclared } from "../src/Run/AddArtifacts.command.ts";
import { ComparisonRecorded } from "../src/Run/RecordComparison.command.ts";
import { ResultsRecorded } from "../src/Run/AddResults.command.ts";
import { Run } from "../src/Run/Run.aggregate.ts";
import { emptySummary } from "../src/Run/Run.values.ts";
import { emptySnapshots } from "../src/Subject/Subject.ts";
import {
  alice,
  asServer,
  console,
  crm,
  DAY,
  inModel,
  noCounts,
  now,
  objectsOf,
  orgA,
  run1,
  runContext,
  Story,
} from "./support.ts";

/**
 * Retention ages runs by their commit times, which the in-memory platform takes from
 * `Date.now`: these stories set the system time (only `Date`; timers stay real) to record
 * history in the past.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

const today = now();
const { org: _, ...runContextOnly } = runContext();
const past = today - 20 * DAY;

/** From this step on, the platform's clock reads `at`. */
const clock = (at: number) =>
  Story.check(`the time is ${new Date(at).toISOString()}`, async () => {
    vi.setSystemTime(at);
  });

const sha = "d".repeat(64);
const shared = "e".repeat(64);
const results = "r/org-a/run-1/b.cases.json";
const snapshots = "r/org-a/run-1/snapshots.json";
const declared = (digest: string, index: number) => ({
  name: `${index}.png`,
  mime: "image/png",
  bytes: 10,
  sha256: digest,
  upload: true,
  generation: 0,
  id: `run-1.${index}`,
  index,
});

const stored = (digest: string) =>
  Story.given(
    Blob.ref(blobId(orgA, digest)),
    new BlobUploadIssued({ generation: 0, bytes: 10, at: past }),
    new BlobStored({ generation: 0 }),
  );

describe("Retention", () => {
  it("purges runs past the plan's retention, keeping bodies a newer run still references", () =>
    console()(
      clock(past),
      Story.given(
        Organization.ref(orgA),
        new OrganizationCreated({
          name: "Acme",
          owner: alice.id,
          ownerEmail: alice.email,
          ownerName: alice.name,
        }),
        new PlanActivated({
          plan: "starter",
          periodStart: past,
          periodEnd: past + 60 * DAY,
          liftsSuspension: false,
        }),
        new UsageReserved({ run: run1, period: past, bytes: 120, artifacts: 2, rows: 1 }),
        // what the organisation accepted, which its run index lists
        new ArtifactsAccepted({
          run: run1,
          project: crm,
          period: past,
          context: runContextOnly,
          artifacts: [declared(sha, 1), declared(shared, 2)].map((a) => ({
            name: a.name,
            mime: a.mime,
            bytes: a.bytes,
            sha256: a.sha256,
            id: a.id,
            index: a.index,
          })),
        }),
        new ResultsAccepted({
          run: run1,
          project: crm,
          period: past,
          kind: "fuzz",
          parts: [
            {
              part: "cases",
              key: results,
              count: 1,
              charged: 1,
              sha256: "b".repeat(64),
              bytes: 100,
            },
          ],
          ...noCounts,
          bytes: 100,
          rows: 50,
          context: runContextOnly,
        }),
        new StorageCharged({ run: run1, bytes: 5 }),
      ),
      Story.given(
        Run.ref(run1),
        new RunCreated(runContext()),
        new ArtifactsDeclared({
          org: orgA,
          period: past,
          artifacts: [declared(sha, 1), declared(shared, 2)],
        }),
        new ResultsRecorded({
          org: orgA,
          period: past,
          parts: [{ part: "cases", key: results, count: 1, charged: 1 }],
          uploads: [],
          ...noCounts,
          bytes: 100,
        }),
        new RunCompleted({
          ...runContext(),
          createdAt: past,
          summary: emptySummary,
          reason: "client",
        }),
        new ComparisonRecorded({
          org: orgA,
          project: crm,
          baseline: null,
          commit: "abcdef0",
          branch: "main",
          pr: null,
          completedAt: past,
          counts: emptySnapshots,
          subjects: [],
          parts: [{ part: "snapshots", key: snapshots, count: 0, charged: 0 }],
          bytes: 5,
          truncated: 0,
        }),
      ),
      stored(sha),
      stored(shared),
      clock(today),
      asServer("a newer run references the shared body", ({ blobs }) =>
        blobs.send(blobId(orgA, shared), new ReferenceBlob({ bytes: 10 })),
      ),
      Db.then(runs.get({ run: run1 }), [{ purged: false, bytes: 125 }]),
      Db.then(billing.get({ org: orgA }), ([row]) => row?.usage.storedBytes === 125),
      // what the daily deadline `RetentionSchedule` armed sends
      Story.remote(Organization.ref(orgA), new SweepRetention({})),
      Db.then(runs.get({ run: run1 }), [{ purged: true }]),
      Db.then(billing.get({ org: orgA }), ([row]) => row?.usage.storedBytes === 0),
      Story.check(
        "its objects are deleted, and only the body nothing references",
        async (world) => {
          const objects = await objectsOf(world);
          expect([...objects.removed].sort()).toEqual(
            [results, snapshots, objectKey(orgA, sha, 0)].sort(),
          );
          const blobs = await inModel(world, ({ blobs }) =>
            Effect.all([blobs.get(blobId(orgA, sha)), blobs.get(blobId(orgA, shared))]),
          );
          expect(blobs.map((b) => b.status)).toEqual(["absent", "stored"]);
          const organization = await inModel(world, ({ organizations }) => organizations.get(orgA));
          expect(organization._tag === "Active" && organization.retainedThrough).toBe(1);
        },
      ),
      // a second pass finds nothing more to purge
      Story.remote(Organization.ref(orgA), new SweepRetention({})),
      Db.then(runs.get({ run: run1 }), [{ purged: true }]),
    ));
});
