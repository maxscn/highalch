import * as Schema from "effect/Schema";

/**
 * The client's own failures, one per reason. Everything HighAlch Console refuses arrives as the
 * domain's own tagged error instead (`NotEntitled`, `QuotaExceeded`, `RunNotOpen`,
 * `ApiKeyInvalid`, …). Messages never contain credentials.
 */

/** A required setting has no value (option or environment variable). */
export class SettingMissing extends Schema.TaggedError<SettingMissing>()("SettingMissing", {
  /** The environment variable that would provide it, e.g. `HIGHALCH_PROJECT`. */
  setting: Schema.String,
}) {}

/** GitHub Actions did not hand out an ID token for audience `highalch`. */
export class OidcTokenUnavailable extends Schema.TaggedError<OidcTokenUnavailable>()(
  "OidcTokenUnavailable",
  { status: Schema.NullOr(Schema.Number), message: Schema.String },
) {}

/** HighAlch Console could not be reached (network, 5xx) after every retry. */
export class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()(
  "ServerUnreachable",
  { operation: Schema.String, message: Schema.String },
) {}

/** HighAlch Console kept answering 429 after every retry. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  operation: Schema.String,
}) {}

/** HighAlch Console answered something the client cannot read (a version mismatch). */
export class UnexpectedResponse extends Schema.TaggedError<UnexpectedResponse>()(
  "UnexpectedResponse",
  { operation: Schema.String, message: Schema.String },
) {}

/** The object store refused a body sent to its signed link (expired, wrong size or digest). */
export class UploadRefused extends Schema.TaggedError<UploadRefused>()("UploadRefused", {
  name: Schema.String,
  status: Schema.Number,
}) {}

/** A single item is larger than a results object may be. */
export class ItemTooLarge extends Schema.TaggedError<ItemTooLarge>()("ItemTooLarge", {
  part: Schema.String,
  bytes: Schema.Number,
  max: Schema.Number,
}) {}

/** An item a reporter built does not match its schema (a reporter bug). */
export class InvalidItem extends Schema.TaggedError<InvalidItem>()("InvalidItem", {
  part: Schema.String,
  message: Schema.String,
}) {}

/** A `story.json` could not be read. */
export class ReportUnreadable extends Schema.TaggedError<ReportUnreadable>()("ReportUnreadable", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** A `story.json` is not a story report this client understands. */
export class ReportInvalid extends Schema.TaggedError<ReportInvalid>()("ReportInvalid", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** Writing the offline `.highalch/` output failed. */
export class WriteFailed extends Schema.TaggedError<WriteFailed>()("WriteFailed", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** The configured project is not the one the credential uploads to. */
export class ProjectMismatch extends Schema.TaggedError<ProjectMismatch>()("ProjectMismatch", {
  configured: Schema.String,
  credential: Schema.String,
}) {}
