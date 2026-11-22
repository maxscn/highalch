import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** What was recorded references an artifact this run never declared. */
export class UnknownArtifact extends Domain.Rejection(
  "UnknownArtifact",
  { artifact: Schema.String },
  { httpApiStatus: 422 },
) {}
