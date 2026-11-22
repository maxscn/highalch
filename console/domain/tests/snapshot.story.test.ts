import { describe, expect, it } from "vite-plus/test";
import { Db } from "@highalch/story/tanstack-db";
import { runs, subjectHistory, subjects } from "../src/Console.collections.ts";
import { RunCompleted } from "../src/Run/FinishRun.command.ts";
import { RunCreated } from "../src/Run/CreateRun.command.ts";
import { ComparisonRecorded, RecordComparison } from "../src/Run/RecordComparison.command.ts";
import { Run } from "../src/Run/Run.aggregate.ts";
import { RunId } from "../src/Run/Run.id.ts";
import { emptySummary } from "../src/Run/Run.values.ts";
import { emptySnapshots, subjectId } from "../src/Subject/Subject.ts";
import {
  acmeCrm,
  alice,
  apiKey,
  bearer,
  bob,
  console,
  crm,
  existingProject,
  now,
  orgA,
  orgB,
  paidOrganization,
  ci,
  openedRun,
  runContext,
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
  paidOrganization(orgB, bob),
  ...existingProject(crm, orgA, { repository: acmeCrm, keys: [crmKey] }),
];

type Org = typeof orgA;

/** A run that completed and was compared earlier, as history (no policy reacts to it). */
const finished = (id: string, org: Org, branch: string) => {
  const context = runContext({ org, branch });
  return Story.given(
    Run.ref(RunId.make(id)),
    new RunCreated(context),
    new RunCompleted({ ...context, createdAt: now(), summary: emptySummary, reason: "client" }),
    new ComparisonRecorded({
      org,
      project: crm,
      baseline: null,
      commit: context.commit,
      branch,
      pr: null,
      completedAt: now(),
      counts: emptySnapshots,
      subjects: [],
      parts: [],
      bytes: 0,
      truncated: 0,
    }),
  );
};

/** CI opened `id` on `branch` and completes it now; `SnapshotComparison` picks its baseline. */
const completes = (id: string, branch: string, baseBranch: string, pr: number | null) => {
  const run = RunId.make(id);
  return [
    ...openedRun(run, { branch, baseBranch, pr }),
    Story.as("ci", Db.when(ci.complete, { org: orgA, run }), Db.settled("Committed")),
  ];
};

const baseline = (id: string, expected: string | null) =>
  Db.then(runs.get({ run: RunId.make(id) }), [
    { compared: true, baseline: expected === null ? null : RunId.make(expected) },
  ]);

describe("Baseline selection", () => {
  it("compares a pull request with the latest completed run of its base branch", () =>
    console(people)(
      ...history,
      finished("r-old", orgA, "main"),
      finished("r-main", orgA, "main"),
      finished("r-feature", orgA, "feature"),
      ...completes("r-pr", "feature", "main", 7),
      baseline("r-pr", "r-main"),
    ));

  it("compares a default-branch run with the previous run on that branch", () =>
    console(people)(
      ...history,
      finished("r-old", orgA, "main"),
      ...completes("r-new", "main", "main", null),
      baseline("r-new", "r-old"),
    ));

  it("has no baseline when the base branch never completed a run", () =>
    console(people)(
      ...history,
      finished("r-dev", orgA, "dev"),
      ...completes("r-pr", "feature", "main", 7),
      baseline("r-pr", null),
    ));

  it("never picks another organisation's run as a baseline", () =>
    console(people)(
      ...history,
      finished("r-theirs", orgB, "main"),
      ...completes("r-mine", "main", "main", null),
      baseline("r-mine", null),
    ));
});

describe("Subjects", () => {
  const tally = (changed: number) => ({
    kind: "component" as const,
    name: "customer/Card",
    items: 3,
    failures: 1,
    snapshots: { ...emptySnapshots, changed, unchanged: 3 - changed },
    schemaHash: "s1:abc",
  });
  const card = subjectId(crm, "component", "customer/Card");
  const done = (id: string) => {
    const context = runContext();
    return Story.given(
      Run.ref(RunId.make(id)),
      new RunCreated(context),
      new RunCompleted({ ...context, createdAt: now(), summary: emptySummary, reason: "client" }),
    );
  };
  const compare = (
    id: string,
    baselineRun: string | null,
    tallies: ReadonlyArray<ReturnType<typeof tally>>,
  ) =>
    Story.remote(
      Run.ref(RunId.make(id)),
      new RecordComparison({
        baseline: baselineRun === null ? null : RunId.make(baselineRun),
        counts: emptySnapshots,
        subjects: tallies,
        parts: [],
        bytes: 0,
        truncated: 0,
      }),
    );

  it("keeps one stable identity per (project, kind, name) across runs", () => {
    expect(subjectId("crm", "component", "customer/Card")).toBe(card);
    expect(subjectId("crm", "page", "customer/Card")).not.toBe(card);
    expect(subjectId("other", "component", "customer/Card")).not.toBe(card);
    return console(people).with({ rules: Db.rules })(
      ...history,
      done("r1"),
      done("r2"),
      compare("r1", null, [tally(0)]),
      Db.then(subjects.list({ project: crm }), [
        { id: card, kind: "component", name: "customer/Card" },
      ]),
      compare("r2", "r1", [tally(2)]),
      // a repeated comparison records nothing
      compare("r2", null, []),
      Db.then(subjects.list({ project: crm }), ([row]) => row?.latest.run === "r2"),
      Db.then(
        subjectHistory.list({ project: crm, subject: card }),
        (rows) =>
          rows
            .map((row) => `${row.run}:${row.snapshots.changed}`)
            .sort()
            .join() === "r1:0,r2:2",
      ),
      Db.then(subjectHistory.list({ project: crm, subject: card, branch: "dev" }), []),
    );
  });
});
