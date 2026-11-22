import type { SyncConfig } from "@tanstack/db";
import { Equal, Option } from "effect";
import type { Delivered } from "./feed";
import * as Rows from "./rows";
import type { Row } from "./values";

type Params = Parameters<SyncConfig<Row, string>["sync"]>[0];
type Write = Parameters<Params["write"]>[0];

type Membership = {
  readonly keyOf: (row: Row) => string;
  readonly member: (row: Row) => Option.Option<boolean>;
};

/** Patch known rows, including confirmed optimistic inserts, and return the sync writes. */
export const apply = (
  rows: Map<string, Row>,
  changes: ReadonlyArray<Delivered>,
  membership: Membership,
  visible: (key: string) => boolean,
): Array<Write> => {
  const writes: Array<Write> = [];

  for (const { change } of changes) {
    if (Rows.isRemoved(change)) {
      if (rows.delete(change.key)) writes.push({ type: "delete", key: change.key });

      continue;
    }

    const row = change.row;
    const key = membership.keyOf(row);
    const belongs = membership.member(row);

    if (rows.has(key)) {
      if (Option.getOrElse(belongs, () => true)) {
        rows.set(key, row);
        writes.push({ type: "update", value: row });
      } else {
        rows.delete(key);
        writes.push({ type: "delete", key });
      }
    } else if (Option.getOrElse(belongs, () => visible(key))) {
      rows.set(key, row);
      writes.push({ type: "insert", value: row });
    }
  }

  return writes;
};

/** Apply changes newer than the query's cursor to its answer. */
export const settle = (
  rows: Map<string, Row>,
  changes: ReadonlyArray<Delivered>,
  membership: Membership,
) => {
  apply(rows, changes, membership, () => false);
};

/** Replay all triggers in order, returning a new snapshot only when the result differs. */
export const rebase = (
  rows: ReadonlyMap<string, Row>,
  changes: ReadonlyArray<Delivered>,
  membership: Membership,
  visible: (key: string) => boolean,
) => {
  if (changes.length === 0) return;

  const patched = new Map(rows);

  apply(patched, changes, membership, visible);

  if (patched.size !== rows.size) return patched;

  for (const [key, row] of patched) if (!Equal.equals(rows.get(key), row)) return patched;
};
