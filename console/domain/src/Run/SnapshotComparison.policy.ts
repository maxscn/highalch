import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChargeStorage } from "../Organization/ChargeStorage.command.ts";
import { Organization } from "../Organization/Organization.aggregate.ts";
import { Storage } from "../Storage.external.ts";
import { RunCompleted } from "./FinishRun.command.ts";
import { OrganizationRuns } from "./OrganizationRuns.stream.ts";
import { RecordComparison } from "./RecordComparison.command.ts";
import { Run } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";
import { RunArtifacts } from "./RunArtifacts.stream.ts";
import { RunResults } from "./RunResults.stream.ts";
import { diff, parse } from "./SnapshotDiff.ts";

/** Every entry of a paged stream read, oldest first. */
export const allEntries = <A, E>(
  page: (
    after: number | undefined,
  ) => Effect.Effect<{ readonly entries: ReadonlyArray<A>; readonly cursor: number | null }, E>,
) =>
  Stream.paginate(undefined as number | undefined, (after: number | undefined) =>
    Effect.map(
      page(after),
      (next) =>
        [
          next.entries,
          next.cursor === null || next.entries.length === 0
            ? Option.none()
            : Option.some(next.cursor),
        ] as const,
    ),
  ).pipe(Stream.runCollect) as Effect.Effect<ReadonlyArray<A>, E>;

/**
 * When a run completes, compare its captures with its baseline: the latest run of the same
 * project and kind on its base branch that completed before it (the PR's target branch, or
 * the run's own branch). Baselines come from the organisation's own run stream, so they never
 * cross organisations. Writes the snapshot map and removed items to storage next to the run's
 * results, records the outcome on the run and charges the bytes to the organisation.
 */
export class SnapshotComparison extends Domain.Policy("SnapshotComparison", {
  from: Run,
  on: [RunCompleted],
}) {}

export const SnapshotComparisonLive = SnapshotComparison.toLayer(
  Effect.gen(function* () {
    const storage = yield* Storage;
    const listed = yield* OrganizationRuns;
    const results = yield* RunResults;
    const artifacts = yield* RunArtifacts;
    const runs = yield* Run;
    const organizations = yield* Organization;

    const side = Effect.fn("SnapshotComparison.side")(function* (run: RunId) {
      const parts = yield* allEntries((after) =>
        results.list(run, { take: 200, ...(after === undefined ? {} : { after }) }),
      );
      const declared = yield* allEntries((after) =>
        artifacts.list(run, { take: 500, ...(after === undefined ? {} : { after }) }),
      );
      // never more items of an object than were charged: the rest are counted, not processed
      const stored = yield* Effect.forEach(
        parts.filter((p) => p.event.part !== "snapshots" && !p.event.key.includes("/removed.")),
        (p) =>
          Effect.map(
            storage.readItems({ key: p.event.key, limit: p.event.charged }),
            ({ items, total }) => ({
              part: p.event.part,
              items: items.slice(0, p.event.charged),
              truncated: Math.max(0, total - p.event.charged),
            }),
          ),
        { concurrency: 4 },
      );
      return {
        truncated: stored.reduce((n, p) => n + p.truncated, 0),
        loaded: parse(stored),
        sha: new Map(declared.map((a) => [a.event.id, a.event.sha256])),
      };
    });

    return Effect.fn("SnapshotComparison")(function* ({ source, event, envelope }) {
      const completedAt = DateTime.toEpochMillis(envelope.at);
      const candidates = yield* listed.list(event.org, {
        where: { project: event.project, kind: event.kind, branch: event.baseBranch },
        order: "desc",
        take: 20,
      });
      const baseline = candidates.entries.find(
        (e) => e.event.run !== source.id && e.event.completedAt <= completedAt,
      );
      const run = RunId.make(source.id);
      const current = yield* side(run);
      const previous = baseline
        ? { run: baseline.event.run, ...(yield* side(RunId.make(baseline.event.run))) }
        : null;
      const result = diff(current, previous);
      const prefix = `r/${event.org}/${source.id}`;
      const written = yield* Effect.forEach(
        [
          {
            part: "snapshots" as const,
            key: `${prefix}/snapshots.json`,
            value: result.snapshots,
            count: Object.keys(result.snapshots).length,
          },
          ...(["tests", "cases", "traces"] as const)
            .filter((part) => result.removed[part].length > 0)
            .map((part) => ({
              part,
              key: `${prefix}/removed.${part}.json`,
              value: result.removed[part],
              count: result.removed[part].length,
            })),
        ],
        (p) =>
          Effect.map(storage.writeJson({ key: p.key, value: p.value as never }), ({ bytes }) => ({
            ...p,
            bytes,
          })),
        { concurrency: 1 },
      );
      const bytes = written.reduce((n, p) => n + p.bytes, 0);
      yield* runs.send(
        source,
        new RecordComparison({
          baseline: previous === null ? null : RunId.make(previous.run),
          counts: result.counts,
          subjects: result.subjects,
          parts: written.map(({ part, key, count }) => ({ part, key, count, charged: count })),
          bytes,
          truncated: current.truncated,
        }),
      );
      yield* organizations.send(event.org, new ChargeStorage({ run, bytes }));
    });
  }),
);
