import * as Effect from "effect/Effect";
import { Db } from "@highalch/story/tanstack-db";
import { describe, expect, it } from "vite-plus/test";
import { Blob } from "../src/Blob/Blob.aggregate.ts";
import { blobId, objectKey } from "../src/Blob/Blob.id.ts";
import { BlobStored } from "../src/Blob/ConfirmBlob.command.ts";
import { ForgetBlob } from "../src/Blob/ForgetBlob.command.ts";
import { BlobUploadIssued, ReferenceBlob } from "../src/Blob/ReferenceBlob.command.ts";
import { artifacts, billing, results, runs } from "../src/Console.collections.ts";
import { NotAllowed } from "../src/NotAllowed.rejection.ts";
import { KindMismatch } from "../src/Organization/RecordResults.command.ts";
import { CheckUploads } from "../src/Run/CheckUploads.command.ts";
import { ExpireRun } from "../src/Run/FinishRun.command.ts";
import { PurgeRun } from "../src/Run/PurgeRun.command.ts";
import { Run } from "../src/Run/Run.aggregate.ts";
import { resultKey } from "../src/Run/Run.values.ts";
import { RunNotOpen } from "../src/Run/RunNotOpen.rejection.ts";
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
  DAY,
  existingProject,
  inModel,
  noCounts,
  now,
  objectsOf,
  openedRun,
  orgA,
  orgB,
  other,
  paidOrganization,
  periodStart,
  refused,
  run1,
  run2,
  runContext,
  session,
  Story,
} from "./support.ts";

const crmKey = apiKey(crm, "k1");
const otherKey = apiKey(other, "k2");
const betaKey = apiKey(billingProject, "k3");

/** Alice watches org-a; CI uploads with crm's key (`ci`), another project's key, or OIDC. */
const people = [
  [orgA, session(alice)],
  ["ci", bearer(crmKey.token)],
  ["other", bearer(otherKey.token)],
  ["beta", bearer(betaKey.token)],
  ["gh", bearer("gh-main")],
] as const;

const history = [
  paidOrganization(orgA, alice),
  paidOrganization(orgB, bob),
  ...existingProject(crm, orgA, { repository: acmeCrm, keys: [crmKey] }),
  ...existingProject(other, orgA, { keys: [otherKey] }),
  ...existingProject(billingProject, orgB, { keys: [betaKey] }),
];

const R1 = Run.ref(run1);
const sha = "a".repeat(64);
const sha2 = "c".repeat(64);
const partSha = "e".repeat(64);
const partKey = resultKey(orgA, run1, { part: "cases", sha256: partSha });

const opening = (run = run1, more: Partial<ReturnType<typeof runContext>> = {}) => ({
  ...runContext(),
  ...more,
  run,
});

const body = (digest: string, bytes: number) => ({
  name: `${digest.slice(0, 1)}.png`,
  mime: "image/png",
  bytes,
  sha256: digest,
});

const declaring = (...bodies: ReadonlyArray<ReturnType<typeof body>>) => ({
  org: orgA,
  run: run1,
  artifacts: bodies,
});

const batch = {
  org: orgA,
  run: run1,
  kind: "fuzz" as const,
  parts: [{ part: "cases" as const, sha256: partSha, bytes: 100, count: 2 }],
  ...noCounts,
  cases: { ok: 1, overflow: 0, crash: 1, a11y: 0 },
};

/** What storage finds once the upload links expired: `ok`, or that a body never arrived. */
const uploaded = (statuses: Record<string, "ok" | "missing" | "mismatch">) =>
  Story.check(`storage holds ${Object.keys(statuses).join(", ")}`, async (world) => {
    const objects = await objectsOf(world);
    for (const [key, status] of Object.entries(statuses)) objects.uploads.set(key, status);
    objects.json.set(partKey, [{ id: "c1" }, { id: "c2" }]);
  });

/** What `UploadDeadlines` schedules once a batch's upload links expired. */
const verification = (
  ...uploads: ReadonlyArray<{
    key: string;
    sha256: string;
    bytes: number;
    generation: number | null;
  }>
) => Story.remote(R1, new CheckUploads({ period: periodStart, uploads }));

describe("Run", () => {
  it("opens, takes its artifacts and results through signed links, completes, is compared", () =>
    console(people).with({ rules: Db.rules })(
      ...history,
      Db.open(runs.list({ org: orgA })),
      Story.as("ci", Db.when(ci.open, opening()), Db.settled("Committed")),
      // the paged list has no rule to place a new run: it reloads after its debounce
      Story.advance(100),
      Db.then(runs.list({ org: orgA }), [{ id: run1, status: "running", commit: "abcdef0" }]),
      ask(
        "declare a body, then its upload link at the declaration's receipt",
        (api) =>
          Effect.flatMap(api.DeclareArtifacts(orgA, declaring(body(sha, 10))), (receipt) =>
            api.UploadLinks(
              { run: run1, artifacts: receipt.reply.ids, results: [] },
              { atLeast: receipt },
            ),
          ),
        (links) => {
          expect(links.artifacts.map((a) => a.id)).toEqual(["run-1.1"]);
          expect(links.artifacts[0]?.link?.url).toContain(
            `memory://put/${objectKey(orgA, sha, 0)}`,
          );
          expect(links.artifacts[0]?.link?.headers["x-amz-checksum-sha256"]).toBe(sha);
        },
        { as: "ci" },
      ),
      ask(
        "record a results batch, then its upload link",
        (api) =>
          Effect.flatMap(api.RecordResults(orgA, batch), (receipt) =>
            api.UploadLinks(
              { run: run1, artifacts: [], results: receipt.reply.keys },
              { atLeast: receipt },
            ),
          ),
        (links) =>
          expect(links.results).toEqual([{ key: partKey, link: expect.objectContaining({}) }]),
        { as: "ci" },
      ),
      Story.settle(),
      Db.then(artifacts.list({ run: run1 }), [
        { id: "run-1.1", index: 1, name: "a.png", bytes: 10, project: crm },
      ]),
      Db.then(results.list({ run: run1 }), [{ key: partKey, part: "cases", count: 2 }]),
      Db.then(
        runs.get({ run: run1 }),
        ([row]) =>
          row?.summary.cases.crash === 1 && row.summary.artifacts === 1 && row.bytes === 110,
      ),
      Db.then(
        billing.get({ org: orgA }),
        ([row]) =>
          row?.usage.activeRuns === 1 &&
          row.usage.storedBytes === 110 &&
          row.usage.artifacts === 1 &&
          row.usage.resultRows === 50,
      ),
      uploaded({ [objectKey(orgA, sha, 0)]: "ok", [partKey]: "ok" }),
      verification(
        { key: objectKey(orgA, sha, 0), sha256: sha, bytes: 10, generation: 0 },
        { key: partKey, sha256: partSha, bytes: 100, generation: null },
      ),
      ask(
        "download links for the body and the results",
        (api) =>
          Effect.all([
            api.ArtifactLinks({ run: run1, ids: ["run-1.1"] }),
            api.ResultPartLinks({ run: run1, keys: [partKey] }),
          ]),
        ([bodies, parts]) => {
          expect(bodies[0]?.link?.url).toContain(`memory://get/${objectKey(orgA, sha, 0)}`);
          expect(parts[0]?.link?.url).toContain(`memory://get/${partKey}`);
        },
      ),
      Story.as("ci", Db.when(ci.complete, { org: orgA, run: run1 }), Db.settled("Committed")),
      Db.then(runs.get({ run: run1 }), [
        { status: "completed", reason: "client", compared: true, baseline: null },
      ]),
      Db.then(results.list({ run: run1 }), [
        { key: partKey, part: "cases" },
        { key: "r/org-a/run-1/snapshots.json", part: "snapshots", count: 0 },
      ]),
      Db.then(billing.get({ org: orgA }), ([row]) => row?.usage.activeRuns === 0),
      Story.as(
        "ci",
        Db.when(ci.complete, { org: orgA, run: run1 }),
        Db.settled("Committed"),
        Db.when(ci.declare, declaring(body(sha2, 5))),
        Db.rejected(new RunNotOpen()),
      ),
    ));

  it("accepts uploads only from its project's key or its repository's OIDC token", () =>
    console(people)(
      ...history,
      Story.as("other", Db.when(ci.open, opening()), Db.rejected(new NotAllowed())),
      Db.when(ci.open, opening()),
      Db.rejected(new NotAllowed()),
      Story.as(
        "gh",
        Db.when(ci.open, opening()),
        Db.settled("Committed"),
        Db.when(ci.declare, declaring(body(sha, 1))),
        Db.settled("Committed"),
      ),
      Story.as(
        "beta",
        Db.when(ci.complete, { org: orgA, run: run1 }),
        Db.rejected(new NotAllowed()),
        Db.when(ci.declare, declaring(body(sha, 1))),
        Db.rejected(new NotAllowed()),
      ),
      Story.as(
        "other",
        Db.when(ci.declare, declaring(body(sha, 1))),
        Db.rejected(new NotAllowed()),
      ),
      Story.as(
        "ci",
        Db.when(ci.record, { ...batch, kind: "playwright" }),
        Db.rejected(new KindMismatch({ expected: "fuzz" })),
        Db.when(ci.declare, { ...declaring(body(sha, 1)), run: run2 }),
        Db.rejected(new RunNotOpen()),
      ),
      refused(
        "a command sent to another organisation than its input names",
        (api) => api.DeclareArtifacts(orgB, declaring(body(sha, 1))),
        "TargetMismatch",
        { as: "ci" },
      ),
      refused(
        "links for an artifact the run never declared",
        (api) => api.UploadLinks({ run: run1, artifacts: ["run-1.9"], results: [] }),
        "UnknownArtifact",
        { as: "ci" },
      ),
      refused(
        "upload links for another project's run",
        (api) => api.UploadLinks({ run: run1, artifacts: ["run-1.1"], results: [] }),
        "NotAllowed",
        { as: "other" },
      ),
    ));

  it("keeps a run id another organisation already holds theirs, and frees the slot", () =>
    console(people)(
      ...history,
      Story.as("ci", Db.when(ci.open, opening()), Db.settled("Committed")),
      Story.as(
        "beta",
        Db.when(ci.open, { ...opening(), org: orgB, project: billingProject }),
        Db.settled("Committed"),
      ),
      Db.then(runs.get({ run: run1 }), [{ org: orgA, project: crm }]),
      Story.check("org-b's slot is free again", async (world) => {
        const state = await inModel(world, ({ organizations }) => organizations.get(orgB));
        expect(state._tag === "Active" && state.openRuns).toEqual([]);
      }),
    ));

  it("expires a run the client never completes and frees its slot", () =>
    console(people)(
      ...history,
      ...openedRun(run1),
      Db.then(runs.get({ run: run1 }), [{ status: "running" }]),
      Db.then(billing.get({ org: orgA }), ([row]) => row?.usage.activeRuns === 1),
      // what the six-hour deadline `RunLifecycle` armed sends
      Story.remote(R1, new ExpireRun({})),
      Db.then(runs.get({ run: run1 }), [
        { status: "completed", reason: "expired", compared: true },
      ]),
      Db.then(billing.get({ org: orgA }), ([row]) => row?.usage.activeRuns === 0),
      Story.as("ci", Db.when(ci.declare, declaring(body(sha, 1))), Db.rejected(new RunNotOpen())),
    ));

  it("purges a run once", () =>
    console(people)(
      ...history,
      ...openedRun(run1),
      Story.remote(R1, new PurgeRun({})),
      Story.remote(R1, new PurgeRun({})),
      Db.then(runs.get({ run: run1 }), [{ purged: true }]),
    ));
});

describe("Upload verification", () => {
  it("gives back the quota of bodies and results that never arrived intact", () =>
    console(people)(
      ...history,
      Story.as(
        "ci",
        Db.when(ci.open, opening()),
        Db.settled("Committed"),
        Db.when(ci.declare, declaring(body(sha, 10), body(sha2, 20))),
        Db.settled("Committed"),
        Db.when(ci.record, batch),
        Db.settled("Committed"),
      ),
      Db.then(runs.get({ run: run1 }), [{ bytes: 130 }]),
      Db.then(
        billing.get({ org: orgA }),
        ([row]) => row?.usage.storedBytes === 130 && row.usage.artifacts === 2,
      ),
      uploaded({ [objectKey(orgA, sha, 0)]: "ok", [objectKey(orgA, sha2, 0)]: "mismatch" }),
      verification(
        { key: objectKey(orgA, sha, 0), sha256: sha, bytes: 10, generation: 0 },
        { key: objectKey(orgA, sha2, 0), sha256: sha2, bytes: 20, generation: 0 },
        { key: partKey, sha256: partSha, bytes: 100, generation: null },
      ),
      Db.then(runs.get({ run: run1 }), [{ bytes: 10 }]),
      Db.then(
        billing.get({ org: orgA }),
        ([row]) =>
          row?.usage.storedBytes === 10 &&
          row.usage.uploadedBytes === 10 &&
          row.usage.artifacts === 1,
      ),
      Story.check("the intact body is stored, the other is gone", async (world) => {
        const states = await inModel(world, ({ blobs }) =>
          Effect.all([blobs.get(blobId(orgA, sha)), blobs.get(blobId(orgA, sha2))]),
        );
        expect(states.map((s) => s.status)).toEqual(["stored", "absent"]);
      }),
    ));
});

describe("Blob", () => {
  const stored = [
    new BlobUploadIssued({ generation: 0, bytes: 10, at: now() }),
    new BlobStored({ generation: 0 }),
  ];

  it("needs no upload for a body the organisation stores, and only there", () =>
    console(people)(
      ...history,
      Story.given(Blob.ref(blobId(orgA, sha)), ...stored),
      ask(
        "declare a stored and a new body",
        (api) =>
          Effect.flatMap(api.OpenRun(orgA, opening()), () =>
            Effect.flatMap(
              api.DeclareArtifacts(orgA, declaring(body(sha, 10), body(sha2, 10))),
              (receipt) =>
                api.UploadLinks(
                  { run: run1, artifacts: receipt.reply.ids, results: [] },
                  { atLeast: receipt },
                ),
            ),
          ),
        (links) => expect(links.artifacts.map((a) => a.link === null)).toEqual([true, false]),
        { as: "ci" },
      ),
      Story.check("org-b's same body is its own", async (world) => {
        const replies = await inModel(world, ({ blobs }) =>
          blobs.send(blobId(orgB, sha), new ReferenceBlob({ bytes: 10 })),
        );
        expect(replies.reply).toEqual({ upload: true, generation: 0 });
      }),
    ));

  it("is forgotten by retention only when unreferenced, and re-uploads under a new generation", () =>
    console(people)(
      Story.given(Blob.ref(blobId(orgA, sha)), ...stored),
      Story.check("forget, reference again", async (world) => {
        const replies = await inModel(world, ({ blobs }) =>
          Effect.all([
            blobs.send(blobId(orgA, sha), new ForgetBlob({ before: now() - DAY })),
            blobs.send(blobId(orgA, sha), new ForgetBlob({ before: now() + DAY })),
            blobs.send(blobId(orgA, sha), new ReferenceBlob({ bytes: 10 })),
          ]),
        );
        expect(replies.map((r) => r.reply)).toEqual([
          { forgotten: false, generation: 0 },
          { forgotten: true, generation: 0 },
          { upload: true, generation: 1 },
        ]);
      }),
    ));
});
