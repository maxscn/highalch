import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Count, Millis } from "../Ids.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { AddStory, StoryRecorded } from "../Story/AddStory.command.ts";
import { replaceStory, storyCounts } from "../Story/Story.values.ts";
import { AddArtifacts, ArtifactsDeclared } from "./AddArtifacts.command.ts";
import { AddResults, ResultsRecorded } from "./AddResults.command.ts";
import { CheckUploads, UploadCheckDue } from "./CheckUploads.command.ts";
import { CreateRun, RunCreated } from "./CreateRun.command.ts";
import { ExpireRun, FinishRun, RunClosing, RunCompleted } from "./FinishRun.command.ts";
import { ForfeitUpload, UploadForfeited } from "./ForfeitUpload.command.ts";
import { PurgeRun, RunPurged } from "./PurgeRun.command.ts";
import { ComparisonRecorded, RecordComparison } from "./RecordComparison.command.ts";
import { RunId } from "./Run.id.ts";
import {
  addSummary,
  CommitInfo,
  StoryCounts,
  CompletionReason,
  emptySummary,
  Kind,
  RunStatus,
  Summary,
} from "./Run.values.ts";

/** A run's fields. Bounded: counters only. Artifacts and results live in streams and objects. */
export const RunFields = {
  org: OrganizationId,
  project: ProjectId,
  commit: Schema.String,
  branch: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  source: Schema.String,
  kind: Kind,
  baseBranch: Schema.String,
  status: RunStatus,
  createdAt: Millis,
  completedAt: Schema.NullOr(Millis),
  reason: Schema.NullOr(CompletionReason),
  summary: Summary,
  bytes: Count,
  purged: Schema.Boolean,
  /** Set once the snapshot comparison is recorded. */
  compared: Schema.Boolean,
  baseline: Schema.NullOr(RunId),
  /** Items of its results objects beyond the rows it was charged: not compared, not shown. */
  truncated: Count,
  /** The commit's message, author and time, as the upload reported them (display only). */
  commitInfo: Schema.NullOr(CommitInfo),
  /** Uploads its organisation forwarded that it applied (artifacts, results, stories). */
  applied: Count,
  /** How many uploads its organisation accepted, once it was asked to complete. */
  closing: Schema.NullOr(Count),
  /** Each recorded story's part of the story counts, by slug (a report replaces its slug's). */
  storyCounts: Schema.Array(Schema.Struct({ slug: Schema.String, counts: StoryCounts })),
};

export const RunInfo = Schema.TaggedStruct("Run", RunFields);
export type RunInfo = typeof RunInfo.Type;

export const RunState = Schema.Union([Schema.TaggedStruct("Unborn", {}), RunInfo]);
export type RunState = typeof RunState.Type;

const ms = (at: DateTime.Utc) => DateTime.toEpochMillis(at);

/** The run, when it is one of `org`'s and still open: what its organisation forwards may change it. */
const openOf = (s: RunState, org: string): RunInfo | undefined =>
  s._tag === "Run" && s.org === org && s.status === "running" ? s : undefined;

/**
 * The completion a write brings, if its organisation already completed the run and this was the
 * last of the writes it accepted: writes may reach the run after `FinishRun`.
 */
const finishing = (run: RunInfo, summary: Summary) =>
  run.closing !== null && run.applied + 1 >= run.closing
    ? [completed({ ...run, summary }, "client")]
    : [];

const completed = (run: RunInfo, reason: "client" | "expired") =>
  new RunCompleted({
    org: run.org,
    project: run.project,
    commit: run.commit,
    branch: run.branch,
    pr: run.pr,
    source: run.source,
    kind: run.kind,
    baseBranch: run.baseBranch,
    createdAt: run.createdAt,
    summary: run.summary,
    reason,
  });

const update = (s: RunState, f: (run: RunInfo) => RunInfo): RunState =>
  s._tag === "Run" ? f(s) : s;

/**
 * A run's history: its context, counters and status. Its organisation decides every upload
 * (quota, who may write, whether the run is open) and `RunIntake` forwards what it accepted
 * here, so the run's commands are the server's own and never refused.
 */
export class Run extends Domain.Aggregate("Run", {
  id: RunId,
  state: RunState,
  initial: { _tag: "Unborn" },
  commands: [
    CreateRun,
    AddArtifacts,
    AddResults,
    AddStory,
    FinishRun,
    ExpireRun,
    CheckUploads,
    ForfeitUpload,
    RecordComparison,
    PurgeRun,
  ],
  decide: {
    CreateRun: (s, cmd) => {
      if (s._tag !== "Unborn") return [];
      const { _tag: _, ...fields } = cmd;
      return [new RunCreated(fields)];
    },
    AddArtifacts: (s, cmd) => {
      const run = openOf(s, cmd.org);
      if (!run) return [];
      const declared = new ArtifactsDeclared({
        org: cmd.org,
        period: cmd.period,
        artifacts: cmd.artifacts,
      });
      return [
        declared,
        ...finishing(run, {
          ...run.summary,
          artifacts: run.summary.artifacts + cmd.artifacts.length,
        }),
      ];
    },
    AddResults: (s, cmd) => {
      const run = openOf(s, cmd.org);
      if (!run) return [];
      const { _tag: _, ...fields } = cmd;
      return [new ResultsRecorded(fields), ...finishing(run, addSummary(run.summary, cmd))];
    },
    AddStory: (s, cmd) => {
      const run = openOf(s, cmd.org);
      if (!run) return [];
      const previous = run.storyCounts.find((each) => each.slug === cmd.story.slug)?.counts;
      const stories = replaceStory(
        run.summary.stories,
        previous,
        storyCounts(cmd.story, cmd.summary),
      );
      return [
        new StoryRecorded({
          org: run.org,
          project: run.project,
          story: cmd.story,
          summary: cmd.summary,
          stories,
        }),
        ...finishing(run, { ...run.summary, stories }),
      ];
    },
    FinishRun: (s, cmd) => {
      const run = openOf(s, cmd.org);
      if (!run) return [];
      return run.applied >= cmd.writes
        ? [completed(run, "client")]
        : [new RunClosing({ expected: cmd.writes })];
    },
    ExpireRun: (s) => (s._tag === "Run" && s.status === "running" ? [completed(s, "expired")] : []),
    CheckUploads: (s, cmd) =>
      s._tag === "Run" && cmd.uploads.length > 0
        ? [new UploadCheckDue({ org: s.org, period: cmd.period, uploads: cmd.uploads })]
        : [],
    ForfeitUpload: (s, cmd) =>
      s._tag === "Run" && cmd.bytes > 0 ? [new UploadForfeited({ bytes: cmd.bytes })] : [],
    RecordComparison: (s, cmd) =>
      s._tag === "Run" && s.status === "completed" && !s.compared
        ? [
            new ComparisonRecorded({
              org: s.org,
              project: s.project,
              baseline: cmd.baseline,
              commit: s.commit,
              branch: s.branch,
              pr: s.pr,
              completedAt: s.completedAt ?? s.createdAt,
              counts: cmd.counts,
              subjects: cmd.subjects,
              parts: cmd.parts,
              bytes: cmd.bytes,
              truncated: cmd.truncated,
            }),
          ]
        : [],
    PurgeRun: (s) => (s._tag === "Run" && !s.purged ? [new RunPurged()] : []),
  },
  evolve: {
    RunCreated: (_, e, envelope) => ({
      _tag: "Run" as const,
      org: e.org,
      project: e.project,
      commit: e.commit,
      branch: e.branch,
      pr: e.pr,
      source: e.source,
      kind: e.kind,
      baseBranch: e.baseBranch,
      status: "running" as const,
      createdAt: ms(envelope.at),
      completedAt: null,
      reason: null,
      summary: emptySummary,
      bytes: 0,
      purged: false,
      compared: false,
      baseline: null,
      truncated: 0,
      commitInfo: e.commitInfo,
      applied: 0,
      closing: null,
      storyCounts: [],
    }),
    ArtifactsDeclared: (s, e) =>
      update(s, (run) => ({
        ...run,
        summary: { ...run.summary, artifacts: run.summary.artifacts + e.artifacts.length },
        bytes: run.bytes + e.artifacts.reduce((n, a) => n + a.bytes, 0),
        applied: run.applied + 1,
      })),
    ResultsRecorded: (s, e) =>
      update(s, (run) => ({
        ...run,
        summary: addSummary(run.summary, e),
        bytes: run.bytes + e.bytes,
        applied: run.applied + 1,
      })),
    RunCompleted: (s, e, envelope) =>
      update(s, (run) => ({
        ...run,
        status: "completed" as const,
        completedAt: ms(envelope.at),
        reason: e.reason,
      })),
    UploadCheckDue: (s) => s,
    UploadForfeited: (s, e) =>
      update(s, (run) => ({ ...run, bytes: Math.max(0, run.bytes - e.bytes) })),
    ComparisonRecorded: (s, e) =>
      update(s, (run) => ({
        ...run,
        compared: true,
        baseline: e.baseline,
        truncated: e.truncated,
        summary: { ...run.summary, snapshots: e.counts },
        bytes: run.bytes + e.bytes,
      })),
    RunPurged: (s) => update(s, (run) => ({ ...run, purged: true })),
    StoryRecorded: (s, e) =>
      update(s, (run) => ({
        ...run,
        applied: run.applied + 1,
        summary: { ...run.summary, stories: e.stories },
        storyCounts: [
          ...run.storyCounts.filter((each) => each.slug !== e.story.slug),
          { slug: e.story.slug, counts: storyCounts(e.story, e.summary) },
        ],
      })),
    RunClosing: (s, e) => update(s, (run) => ({ ...run, closing: e.expected })),
  },
  reply: {
    CreateRun: (s) => ({ org: s._tag === "Run" ? s.org : null }),
    AddArtifacts: (_, events) => ({ applied: events.length > 0 }),
    AddResults: (_, events) => ({ applied: events.length > 0 }),
    AddStory: (_, events) => ({ applied: events.length > 0 }),
  },
}) {}
