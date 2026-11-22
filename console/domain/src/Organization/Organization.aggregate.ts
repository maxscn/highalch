import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mayUpload, Role, type Actor } from "../Actor.ts";
import { findPlan, findTopUp } from "../Billing/Plan.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Count, Millis, UserId } from "../Ids.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { RunId } from "../Run/Run.id.ts";
import { ActivatePlan, PlanActivated } from "./ActivatePlan.command.ts";
import { AdvanceRetention, RetentionAdvanced } from "./AdvanceRetention.command.ts";
import { ChargeStorage, StorageCharged } from "./ChargeStorage.command.ts";
import { RetentionDue, SweepRetention } from "./SweepRetention.command.ts";
import {
  access,
  currentUsage,
  effectiveLimits,
  emptyUsage,
  Entitlement,
  PeriodUsage,
} from "./Billing.ts";
import {
  CreateOrganization,
  OrganizationCreated,
  OrganizationExists,
} from "./CreateOrganization.command.ts";
import { CreditTopUp, TopUpCredited } from "./CreditTopUp.command.ts";
import { CustomerLinked, LinkCustomer } from "./LinkCustomer.command.ts";
import { NotEntitled } from "./NotEntitled.rejection.ts";
import {
  CloseRun,
  CompleteRun,
  OpenRun,
  RunClosed,
  RunContextStruct,
  RunOpened,
} from "./OpenRun.command.ts";
import { ArtifactsAccepted, DeclareArtifacts } from "./DeclareArtifacts.command.ts";
import { KindMismatch, RecordResults, ResultsAccepted } from "./RecordResults.command.ts";
import { OrganizationId } from "./Organization.id.ts";
import { OrganizationMissing } from "./OrganizationMissing.rejection.ts";
import { QuotaExceeded } from "./QuotaExceeded.rejection.ts";
import { ReleaseUsage, UsageReleased } from "./ReleaseUsage.command.ts";
import { UsageReserved } from "./UsageReserved.event.ts";
import { RecordStory, StoryAccepted } from "../Story/RecordStory.command.ts";
import { artifactId, parseArtifactId } from "../Run/Run.id.ts";
import { RunNotOpen } from "../Run/RunNotOpen.rejection.ts";
import { UnknownArtifact } from "../Run/UnknownArtifact.rejection.ts";
import { Kind, resultKey } from "../Run/Run.values.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { chargedRows, chargedStoryRows, minRowsPerBatch } from "../Billing/Plan.ts";
import { sameTarget } from "../TargetMismatch.rejection.ts";
import {
  BillingResumed,
  BillingSuspended,
  ResumeBilling,
  SuspendBilling,
} from "./SuspendBilling.command.ts";

export const Member = Schema.Struct({
  user: UserId,
  role: Role,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  joinedAt: Millis,
});

/**
 * An open run: whose it is, its kind, how many artifacts it declared, how many uploads were
 * accepted for it, and its context.
 */
export const OpenRunEntry = Schema.Struct({
  run: RunId,
  project: ProjectId,
  kind: Kind,
  artifacts: Count,
  writes: Count,
  context: RunContextStruct,
});
export type OpenRunEntry = typeof OpenRunEntry.Type;

export const ActiveOrganization = Schema.TaggedStruct("Active", {
  name: Schema.String,
  owner: UserId,
  createdAt: Millis,
  members: Schema.Array(Member),
  entitlement: Entitlement,
  usage: PeriodUsage,
  storedBytes: Count,
  openRuns: Schema.Array(OpenRunEntry),
  /** Uploads it accepted that their run could not take (released, reason `dropped`). */
  droppedWrites: Count,
  retainedThrough: Schema.Number,
});
export type ActiveOrganization = typeof ActiveOrganization.Type;

export const OrganizationState = Schema.Union([
  Schema.TaggedStruct("Unborn", {}),
  ActiveOrganization,
]);
export type OrganizationState = typeof OrganizationState.Type;

const ms = (at: DateTime.Utc) => DateTime.toEpochMillis(at);

const active = (s: OrganizationState): ActiveOrganization | OrganizationMissing =>
  s._tag === "Active" ? s : new OrganizationMissing();

const isSystem = (actor: Actor) => actor._tag === "System";

/** Uploads into `org` come from its keys and upload tokens, or the server itself. */
const mayUse = (actor: Actor, org: string) =>
  actor._tag === "System" ||
  ((actor._tag === "Key" || actor._tag === "Uploader") && actor.org === org);

/**
 * A GitHub OIDC upload's commit, branch and pull request are the verified ones, whatever the
 * client reported; a pull request's baseline branch is its verified base when GitHub names one.
 */
const verified = (context: Omit<OpenRun, "_tag" | "org" | "run">, actor: Actor) => {
  if (actor._tag !== "Uploader" || actor.context === null) return context;
  const { commit, branch, pr, baseBranch } = actor.context;
  return {
    ...context,
    commit,
    branch,
    pr,
    baseBranch: pr === null ? branch : (baseBranch ?? context.baseBranch),
    pull: pr === null ? null : context.pull,
  };
};

/** The open run `run` of `org`, if the caller may upload to it. */
const uploadable = Effect.fn(function* (o: ActiveOrganization, org: string, run: string) {
  const actor = yield* CurrentActor;
  if (!mayUse(actor, org)) return yield* new NotAllowed();
  const entry = o.openRuns.find((open) => open.run === run);
  if (entry === undefined) return yield* new RunNotOpen();
  if (!mayUpload(actor, org, entry.project, run)) return yield* new NotAllowed();
  return entry;
});

/** Reserves quota for an upload of `run`, or says which cap it would exceed. */
const reserve = Effect.fn(function* (
  o: ActiveOrganization,
  now: number,
  request: {
    readonly run: RunId;
    readonly bytes: number;
    readonly artifacts: number;
    readonly rows: number;
    readonly largest: number;
  },
) {
  const granted = access(o.entitlement, now);
  if (granted._tag === "Denied") return yield* new NotEntitled({ reason: granted.reason });
  const usage = currentUsage(o.entitlement, o.usage);
  const limits = effectiveLimits(granted.limits, usage);
  const checks = [
    ["maxArtifactBytes", limits.maxArtifactBytes, 0, request.largest],
    ["storedBytes", limits.storedBytes, o.storedBytes, request.bytes],
    ["uploadedBytesPerPeriod", limits.uploadedBytesPerPeriod, usage.uploadedBytes, request.bytes],
    ["artifactsPerPeriod", limits.artifactsPerPeriod, usage.artifacts, request.artifacts],
    ["resultRowsPerPeriod", limits.resultRowsPerPeriod, usage.resultRows, request.rows],
  ] as const;
  for (const [limit, max, used, requested] of checks)
    if (used + requested > max) return yield* new QuotaExceeded({ limit, max, used, requested });
  return new UsageReserved({ ...request, period: usage.period });
});

const encoder = new TextEncoder();

/** One more upload accepted for the open run `run`. */
const written = (s: OrganizationState, run: string): OrganizationState =>
  update(s, (o) => ({
    ...o,
    openRuns: o.openRuns.map((open) =>
      open.run === run ? { ...open, writes: open.writes + 1 } : open,
    ),
  }));

const update = (
  s: OrganizationState,
  f: (o: ActiveOrganization) => ActiveOrganization,
): OrganizationState => (s._tag === "Active" ? f(s) : s);

/** Usage counters of the period the event belongs to (resetting when a new period starts). */
const usageFor = (o: ActiveOrganization, period: number) =>
  o.usage.period === period ? o.usage : emptyUsage(period);

export class Organization extends Domain.Aggregate("Organization", {
  id: OrganizationId,
  state: OrganizationState,
  initial: { _tag: "Unborn" },
  commands: [
    CreateOrganization,
    LinkCustomer,
    ActivatePlan,
    CreditTopUp,
    SuspendBilling,
    ResumeBilling,
    DeclareArtifacts,
    RecordResults,
    RecordStory,
    CompleteRun,
    ReleaseUsage,
    OpenRun,
    CloseRun,
    AdvanceRetention,
    ChargeStorage,
    SweepRetention,
  ],
  decide: {
    CreateOrganization: Effect.fn(function* (s, cmd, { id }) {
      yield* sameTarget(cmd.org, id);
      const actor = yield* CurrentActor;
      if (!(actor._tag === "User" && actor.user === cmd.owner) && !isSystem(actor))
        return yield* new NotAllowed();
      if (s._tag !== "Unborn") return yield* new OrganizationExists();
      return [
        new OrganizationCreated({
          name: cmd.name,
          owner: cmd.owner,
          ownerEmail: cmd.ownerEmail,
          ownerName: cmd.ownerName,
        }),
      ];
    }),
    LinkCustomer: Effect.fn(function* (s, cmd) {
      const o = active(s);
      if (o._tag !== "Active") return yield* o;
      if (!isSystem(yield* CurrentActor)) return yield* new NotAllowed();
      if (o.entitlement.customer === cmd.customer) return [];
      return [new CustomerLinked({ customer: cmd.customer })];
    }),
    ActivatePlan: Effect.fn(function* (s, cmd) {
      const o = active(s);
      if (o._tag !== "Active") return yield* o;
      if (!isSystem(yield* CurrentActor)) return yield* new NotAllowed();
      const current = o.entitlement;
      // an out-of-order or replayed older invoice never shortens or rewinds the period
      if (
        current.periodEnd !== null &&
        cmd.periodEnd <= current.periodEnd &&
        current.plan === cmd.plan
      )
        return [];
      return [
        new PlanActivated({
          plan: cmd.plan,
          periodStart: cmd.periodStart,
          periodEnd: cmd.periodEnd,
          liftsSuspension: current.suspended === "payment_failed",
        }),
      ];
    }),
    CreditTopUp: Effect.fn(function* (s, cmd) {
      const o = active(s);
      if (o._tag !== "Active") return yield* o;
      if (!isSystem(yield* CurrentActor)) return yield* new NotAllowed();
      const pack = findTopUp(cmd.topUp);
      if (!pack) return yield* new NotAllowed();
      return [
        new TopUpCredited({
          topUp: pack.id,
          period: o.entitlement.periodStart ?? 0,
          uploadedBytes: pack.adds.uploadedBytes,
          artifacts: pack.adds.artifacts,
          resultRows: pack.adds.resultRows,
        }),
      ];
    }),
    SuspendBilling: Effect.fn(function* (s, cmd) {
      const o = active(s);
      if (o._tag !== "Active") return yield* o;
      if (!isSystem(yield* CurrentActor)) return yield* new NotAllowed();
      if (o.entitlement.suspended === cmd.reason) return [];
      return [new BillingSuspended({ reason: cmd.reason })];
    }),
    ResumeBilling: Effect.fn(function* (s, cmd) {
      const o = active(s);
      if (o._tag !== "Active") return yield* o;
      if (!isSystem(yield* CurrentActor)) return yield* new NotAllowed();
      if (o.entitlement.suspended !== cmd.reason) return [];
      return [new BillingResumed({ reason: cmd.reason })];
    }),
    DeclareArtifacts: Effect.fn(function* (s, cmd, { now, id }) {
      yield* sameTarget(cmd.org, id);
      const o = active(s);
      if (o._tag !== "Active") return yield* o;
      const entry = yield* uploadable(o, id, cmd.run);
      const reserved = yield* reserve(o, ms(now), {
        run: cmd.run,
        bytes: cmd.artifacts.reduce((n, a) => n + a.bytes, 0),
        artifacts: cmd.artifacts.length,
        rows: 0,
        largest: cmd.artifacts.reduce((n, a) => Math.max(n, a.bytes), 0),
      });
      const artifacts = cmd.artifacts.map((artifact, offset) => {
        const index = entry.artifacts + offset + 1;
        return { ...artifact, index, id: artifactId(cmd.run, index) };
      });
      return [
        reserved,
        new ArtifactsAccepted({
          run: cmd.run,
          project: entry.project,
          period: reserved.period,
          artifacts,
          context: entry.context,
        }),
      ];
    }),
    RecordResults: Effect.fn(function* (s, cmd, { now, id }) {
      yield* sameTarget(cmd.org, id);
      const o = active(s);
      if (o._tag !== "Active") return yield* o;
      const entry = yield* uploadable(o, id, cmd.run);
      if (entry.kind !== cmd.kind) return yield* new KindMismatch({ expected: entry.kind });
      const bytes = cmd.parts.reduce((n, p) => n + p.bytes, 0);
      // the reported items, but never fewer than the objects' bytes can hold
      const rows = cmd.parts.reduce((n, p) => n + chargedRows(p), 0);
      const reserved = yield* reserve(o, ms(now), {
        run: cmd.run,
        bytes,
        artifacts: 0,
        rows: Math.max(rows, minRowsPerBatch),
        largest: 0,
      });
      const context = entry.context;
      return [
        reserved,
        new ResultsAccepted({
          run: cmd.run,
          project: entry.project,
          period: reserved.period,
          kind: cmd.kind,
          parts: cmd.parts.map((p) => ({
            ...p,
            key: resultKey(id, cmd.run, p),
            charged: chargedRows(p),
          })),
          tests: cmd.tests,
          cases: cmd.cases,
          traces: cmd.traces,
          bytes,
          rows: reserved.rows,
          context,
        }),
      ];
    }),
    RecordStory: Effect.fn(function* (s, cmd, { now, id }) {
      yield* sameTarget(cmd.org, id);
      const o = active(s);
      if (o._tag !== "Active") return yield* o;
      const entry = yield* uploadable(o, id, cmd.run);
      const unknown = [cmd.story.report, ...cmd.frames].find((artifact) => {
        const parsed = parseArtifactId(artifact);
        return parsed === undefined || parsed.run !== cmd.run || parsed.index > entry.artifacts;
      });
      if (unknown !== undefined) return yield* new UnknownArtifact({ artifact: unknown });
      const reserved = yield* reserve(o, ms(now), {
        run: cmd.run,
        bytes: 0,
        artifacts: 0,
        rows: chargedStoryRows({
          bytes: encoder.encode(JSON.stringify({ story: cmd.story, summary: cmd.summary }))
            .byteLength,
        }),
        largest: 0,
      });
      return [
        reserved,
        new StoryAccepted({
          run: cmd.run,
          project: entry.project,
          period: reserved.period,
          rows: reserved.rows,
          story: cmd.story,
          summary: cmd.summary,
          context: entry.context,
        }),
      ];
    }),
    CompleteRun: Effect.fn(function* (s, cmd, { id }) {
      yield* sameTarget(cmd.org, id);
      const o = active(s);
      if (o._tag !== "Active") return yield* o;
      const entry = o.openRuns.find((open) => open.run === cmd.run);
      if (entry === undefined) return [];
      if (!mayUpload(yield* CurrentActor, id, entry.project, cmd.run))
        return yield* new NotAllowed();
      return [new RunClosed({ run: cmd.run, writes: entry.writes, context: entry.context })];
    }),
    ReleaseUsage: (s, cmd) => {
      if (s._tag !== "Active") return [];
      if (cmd.bytes === 0 && cmd.artifacts === 0 && cmd.rows === 0 && cmd.reason !== "dropped")
        return [];
      const { _tag: _, ...released } = cmd;
      return [new UsageReleased(released)];
    },
    OpenRun: Effect.fn(function* (s, cmd, { now, id }) {
      yield* sameTarget(cmd.org, id);
      const o = active(s);
      if (o._tag !== "Active") return yield* o;
      const actor = yield* CurrentActor;
      // a run's own upload credential cannot open further runs
      if (
        !mayUpload(actor, id, cmd.project, null) ||
        (actor._tag === "Uploader" && actor.run !== null)
      )
        return yield* new NotAllowed();
      if (o.openRuns.some((open) => open.run === cmd.run)) return [];
      const granted = access(o.entitlement, ms(now));
      if (granted._tag === "Denied") return yield* new NotEntitled({ reason: granted.reason });
      const usage = currentUsage(o.entitlement, o.usage);
      if (o.openRuns.length + 1 > granted.limits.activeRuns)
        return yield* new QuotaExceeded({
          limit: "activeRuns",
          max: granted.limits.activeRuns,
          used: o.openRuns.length,
          requested: 1,
        });
      if (usage.runs + 1 > granted.limits.runsPerPeriod)
        return yield* new QuotaExceeded({
          limit: "runsPerPeriod",
          max: granted.limits.runsPerPeriod,
          used: usage.runs,
          requested: 1,
        });
      const { _tag: _, org: __, run, ...context } = cmd;
      return [new RunOpened({ run, period: usage.period, ...verified(context, actor) })];
    }),
    CloseRun: (s, cmd) => {
      const entry =
        s._tag === "Active" ? s.openRuns.find((open) => open.run === cmd.run) : undefined;
      return entry === undefined
        ? []
        : [new RunClosed({ run: cmd.run, writes: entry.writes, context: entry.context })];
    },
    ChargeStorage: (s, cmd) =>
      s._tag === "Active" && cmd.bytes > 0
        ? [new StorageCharged({ run: cmd.run, bytes: cmd.bytes })]
        : [],
    SweepRetention: (s, _cmd, { now }) => {
      if (s._tag !== "Active" || s.entitlement.plan === null) return [];
      const days = findPlan(s.entitlement.plan)?.limits.retentionDays ?? 0;
      return [new RetentionDue({ cutoff: ms(now) - days * 86_400_000, after: s.retainedThrough })];
    },
    AdvanceRetention: (s, cmd) =>
      s._tag === "Active" && cmd.through > s.retainedThrough
        ? [new RetentionAdvanced({ through: cmd.through })]
        : [],
  },
  evolve: {
    OrganizationCreated: (_, e, envelope) => ({
      _tag: "Active" as const,
      name: e.name,
      owner: e.owner,
      createdAt: ms(envelope.at),
      members: [
        {
          user: e.owner,
          role: "owner" as const,
          email: e.ownerEmail,
          name: e.ownerName,
          joinedAt: ms(envelope.at),
        },
      ],
      entitlement: {
        plan: null,
        periodStart: null,
        periodEnd: null,
        suspended: null,
        customer: null,
      },
      usage: emptyUsage(0),
      storedBytes: 0,
      openRuns: [],
      droppedWrites: 0,
      retainedThrough: 0,
    }),
    CustomerLinked: (s, e) =>
      update(s, (o) => ({ ...o, entitlement: { ...o.entitlement, customer: e.customer } })),
    PlanActivated: (s, e) =>
      update(s, (o) => ({
        ...o,
        entitlement: {
          ...o.entitlement,
          plan: e.plan,
          periodStart: e.periodStart,
          periodEnd: e.periodEnd,
          suspended: e.liftsSuspension ? null : o.entitlement.suspended,
        },
        usage: usageFor(o, e.periodStart),
      })),
    TopUpCredited: (s, e) =>
      update(s, (o) => {
        const usage = usageFor(o, e.period);
        return {
          ...o,
          usage: {
            ...usage,
            topUpBytes: usage.topUpBytes + e.uploadedBytes,
            topUpArtifacts: usage.topUpArtifacts + e.artifacts,
            topUpRows: usage.topUpRows + e.resultRows,
          },
        };
      }),
    BillingSuspended: (s, e) =>
      update(s, (o) => ({ ...o, entitlement: { ...o.entitlement, suspended: e.reason } })),
    BillingResumed: (s) =>
      update(s, (o) => ({ ...o, entitlement: { ...o.entitlement, suspended: null } })),
    UsageReserved: (s, e) =>
      update(s, (o) => {
        const usage = usageFor(o, e.period);
        return {
          ...o,
          storedBytes: o.storedBytes + e.bytes,
          usage: {
            ...usage,
            uploadedBytes: usage.uploadedBytes + e.bytes,
            artifacts: usage.artifacts + e.artifacts,
            resultRows: usage.resultRows + e.rows,
          },
        };
      }),
    UsageReleased: (s, e) =>
      update(s, (o) => ({
        ...o,
        droppedWrites: o.droppedWrites + (e.reason === "dropped" ? 1 : 0),
        storedBytes: Math.max(0, o.storedBytes - e.bytes),
        usage:
          e.period !== null && e.period === o.usage.period
            ? {
                ...o.usage,
                uploadedBytes: Math.max(0, o.usage.uploadedBytes - e.bytes),
                artifacts: Math.max(0, o.usage.artifacts - e.artifacts),
                resultRows: Math.max(0, o.usage.resultRows - e.rows),
              }
            : o.usage,
      })),
    RunOpened: (s, e) =>
      update(s, (o) => {
        const usage = usageFor(o, e.period);
        return {
          ...o,
          openRuns: [
            ...o.openRuns,
            {
              run: e.run,
              project: e.project,
              kind: e.kind,
              artifacts: 0,
              writes: 0,
              context: {
                project: e.project,
                commit: e.commit,
                branch: e.branch,
                pr: e.pr,
                source: e.source,
                kind: e.kind,
                baseBranch: e.baseBranch,
                commitInfo: e.commitInfo,
                pull: e.pull,
              },
            },
          ],
          usage: { ...usage, runs: usage.runs + 1 },
        };
      }),
    RunClosed: (s, e) =>
      update(s, (o) => ({ ...o, openRuns: o.openRuns.filter((open) => open.run !== e.run) })),
    ArtifactsAccepted: (s, e) =>
      update(s, (o) => ({
        ...o,
        openRuns: o.openRuns.map((open) =>
          open.run === e.run
            ? { ...open, artifacts: open.artifacts + e.artifacts.length, writes: open.writes + 1 }
            : open,
        ),
      })),
    ResultsAccepted: (s, e) => written(s, e.run),
    StoryAccepted: (s, e) => written(s, e.run),
    StorageCharged: (s, e) => update(s, (o) => ({ ...o, storedBytes: o.storedBytes + e.bytes })),
    RetentionDue: (s) => s,
    RetentionAdvanced: (s, e) => update(s, (o) => ({ ...o, retainedThrough: e.through })),
  },
  reply: {
    DeclareArtifacts: (_, events) => ({
      ids: events.flatMap((e) =>
        e._tag === "ArtifactsAccepted" ? e.artifacts.map((a) => a.id) : [],
      ),
    }),
    RecordResults: (_, events) => ({
      keys: events.flatMap((e) => (e._tag === "ResultsAccepted" ? e.parts.map((p) => p.key) : [])),
    }),
  },
}) {}
