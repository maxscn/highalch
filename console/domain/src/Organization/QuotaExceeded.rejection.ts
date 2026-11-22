import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** A hard cap would be exceeded. Nothing was reserved. */
export class QuotaExceeded extends Domain.Rejection(
  "QuotaExceeded",
  {
    limit: Schema.Literals([
      "storedBytes",
      "uploadedBytesPerPeriod",
      "artifactsPerPeriod",
      "resultRowsPerPeriod",
      "runsPerPeriod",
      "activeRuns",
      "maxArtifactBytes",
    ]),
    max: Schema.Number,
    used: Schema.Number,
    requested: Schema.Number,
  },
  { httpApiStatus: 402 },
) {}
