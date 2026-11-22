import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allEntries } from "./SnapshotComparison.policy.ts";
import type { RunArtifacts } from "./RunArtifacts.stream.ts";
import type { RunResults } from "./RunResults.stream.ts";
import type { RunId } from "./Run.id.ts";
import { Millis } from "../Ids.ts";

/** A signed link, or `null` when there is nothing to transfer (a stored body, a purged run). */
export const SignedLink = Schema.NullOr(
  Schema.Struct({
    url: Schema.String,
    /** Headers to send exactly as given (a PUT link binds size, type and digest). */
    headers: Schema.Record(Schema.String, Schema.String),
    expiresAt: Millis,
  }),
);
export type SignedLink = typeof SignedLink.Type;

/** A run's artifacts by id, as its index lists them. */
export const artifactsOf = (index: (typeof RunArtifacts)["Service"], run: RunId) =>
  Effect.map(
    allEntries((after) =>
      index.list(run, { take: 500, ...(after === undefined ? {} : { after }) }),
    ),
    (entries) => new Map(entries.map(({ event }) => [event.id, event])),
  );

/** A run's results objects by key, as its index lists them. */
export const resultsOf = (index: (typeof RunResults)["Service"], run: RunId) =>
  Effect.map(
    allEntries((after) =>
      index.list(run, { take: 200, ...(after === undefined ? {} : { after }) }),
    ),
    (entries) => new Map(entries.map(({ event }) => [event.key, event])),
  );
