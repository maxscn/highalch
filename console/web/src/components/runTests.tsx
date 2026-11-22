import { results } from "@highalch/console-domain/Console.collections";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import * as HighAlch from "@lowalch/tanstack-db";
import { useLiveQuery } from "@tanstack/react-db";
import { Suspense, use, type ReactNode } from "react";
import {
  elementsOf,
  itemsOf,
  linksOf,
  partsOf,
  snapshotsOf,
  TestItem,
  type ItemsUnavailable,
  type ItemsUndecodable,
  type Loaded,
  type SnapshotEntry,
  type Snapshots,
} from "../data/items.ts";
import { FailedPanel } from "./states.tsx";

export type Test = typeof TestItem.Type;

type Render = (
  tests: ReadonlyArray<Test>,
  snapshots: ReadonlyMap<string, SnapshotEntry>,
) => ReactNode;

/**
 * A run's Playwright tests and its snapshot map, read the way every result item is: the run's
 * result index (rows, live), signed links for its parts (a query), then the parts' JSON from
 * storage (Suspense). `fallback` shows while any of it loads; failures render as a panel.
 */
export const RunTests = ({
  run,
  fallback,
  children,
}: {
  readonly run: string;
  readonly fallback: ReactNode;
  readonly children: Render;
}) => {
  const index = useLiveQuery((q) => q.from({ part: results.list({ run: RunId.make(run) }) }));
  return HighAlch.match(index).on({
    Loading: () => fallback,
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data: parts }) => {
      const tests = partsOf(parts, "tests");
      const snapshots = parts.filter((part) => part.part === "snapshots");
      return (
        <Links
          run={run}
          keys={[...tests, ...snapshots].map((part) => part.key)}
          charged={new Map(tests.map((part) => [part.key, part.charged]))}
          snapshotKeys={snapshots.map((part) => part.key)}
          fallback={fallback}
        >
          {children}
        </Links>
      );
    },
    orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
  });
};

const Links = ({
  run,
  keys,
  charged,
  snapshotKeys,
  fallback,
  children,
}: {
  readonly run: string;
  readonly keys: ReadonlyArray<string>;
  /** Items of each part the run was charged for: at most these are shown. */
  readonly charged: ReadonlyMap<string, number>;
  readonly snapshotKeys: ReadonlyArray<string>;
  readonly fallback: ReactNode;
  readonly children: Render;
}) => {
  const result = useLiveQuery((q) => q.from({ links: linksOf(run, keys) }));
  return HighAlch.match(result).on({
    Loading: () => fallback,
    [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) => {
      // A `HighAlch.query` answer is one row: the array of links asked for.
      const links = data.flatMap((answer) => elementsOf(answer));
      const snapshot = links.find((link) => snapshotKeys.includes(link.key));
      return (
        <Suspense fallback={fallback}>
          <Loaded
            tests={itemsOf(
              "tests",
              TestItem,
              links
                .filter((link) => !snapshotKeys.includes(link.key))
                .map((link) => ({ ...link, charged: charged.get(link.key) ?? 0 })),
            )}
            snapshots={snapshot === undefined ? null : snapshotsOf(snapshot)}
          >
            {children}
          </Loaded>
        </Suspense>
      );
    },
    orElse: (error, { retry }) => <FailedPanel error={error} retry={retry} />,
  });
};

const none: ReadonlyMap<string, SnapshotEntry> = new Map();

const Loaded = ({
  tests,
  snapshots,
  children,
}: {
  readonly tests: Promise<Loaded<Test>>;
  readonly snapshots: Promise<Snapshots | ItemsUnavailable | ItemsUndecodable> | null;
  readonly children: Render;
}) => {
  const loaded = use(tests);
  const map = snapshots === null ? null : use(snapshots);
  // The snapshot map only adds the "changed" marks: without it, every test still shows.
  const entries = map !== null && map._tag === "Snapshots" ? map.entries : none;
  return HighAlch.match(loaded).on({
    Items: ({ items }) => children(items, entries),
    ItemsUnavailable: (error) => <FailedPanel error={error} />,
    ItemsUndecodable: (error) => <FailedPanel error={error} />,
  });
};
