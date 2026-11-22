import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** A results object key this run's index does not hold. */
export class UnknownResultPart extends Domain.Rejection(
  "UnknownResultPart",
  { key: Schema.String },
  { httpApiStatus: 422 },
) {}
