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

const keyOf = (entry: Delivered, membership: Membership) => {
  if (Rows.isRemoved(entry.change)) return entry.change.key;

  return membership.keyOf(entry.change.row);
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

/** Keep the feed's version on contradictions, retiring changes acknowledged by the answer. */
export const reconcile = (
  rows: Map<string, Row>,
  applied: Map<string, Delivered>,
  cursor: number,
) => {
  let contradicted = false;

  for (const [key, entry] of applied) {
    if (entry.seq > cursor) continue;

    const row = rows.get(key);

    if (!row || (!Rows.isRemoved(entry.change) && Equal.equals(row, entry.change.row))) {
      applied.delete(key);
      continue;
    }

    contradicted = true;

    if (Rows.isRemoved(entry.change)) rows.delete(key);
    else rows.set(key, entry.change.row);
  }

  return contradicted;
};

/** Remember removals even outside the page, and upserts whose values the feed actually placed. */
export const remember = (
  changes: ReadonlyArray<Delivered>,
  applied: Map<string, Delivered>,
  rows: ReadonlyMap<string, Row>,
  membership: Membership,
) => {
  for (const entry of changes) {
    const key = keyOf(entry, membership);

    if (Rows.isRemoved(entry.change) || rows.has(key)) applied.set(key, entry);
    else applied.delete(key);
  }
};
