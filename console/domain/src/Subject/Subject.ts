import * as Schema from "effect/Schema";
import { Count } from "../Ids.ts";

export const SubjectKind = Schema.Literals(["component", "part", "page"]);
export type SubjectKind = typeof SubjectKind.Type;

export const Subject = Schema.Struct({ kind: SubjectKind, name: Schema.String });
export type Subject = typeof Subject.Type;

export const SnapshotCounts = Schema.Struct({
  unchanged: Count,
  changed: Count,
  new: Count,
  removed: Count,
  "schema-changed": Count,
});
export type SnapshotCounts = typeof SnapshotCounts.Type;

export const emptySnapshots: SnapshotCounts = {
  unchanged: 0,
  changed: 0,
  new: 0,
  removed: 0,
  "schema-changed": 0,
};

/** One subject's results in one run. */
export const SubjectTally = Schema.Struct({
  kind: SubjectKind,
  name: Schema.String,
  items: Count,
  failures: Count,
  snapshots: SnapshotCounts,
  schemaHash: Schema.NullOr(Schema.String),
});
export type SubjectTally = typeof SubjectTally.Type;

const fnv64 = (text: string) => {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
};

/** Stable id of a subject within a project: the same (project, kind, name) is always the same id. */
export const subjectId = (project: string, kind: SubjectKind, name: string) =>
  `sub_${fnv64(`${project}\n${kind}\n${name}`)}`;
