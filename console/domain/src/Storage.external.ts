import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * The object store (R2 in production), implemented by the server: artifact bodies under
 * `a/<org>/<sha256>/<generation>`, results objects under `r/<org>/<run>/…`. Links are signed
 * here; the model decides who gets one, for which key, size, digest and type.
 */
export class Storage extends Domain.ExternalSystem(
  "Storage",
  {
    /** Checks an uploaded body against its declaration; deletes it when size or digest differ. */
    inspect: {
      args: { key: Schema.String, bytes: Schema.Number, sha256: Schema.String },
      success: { status: Schema.Literals(["ok", "missing", "mismatch"]) },
    },
    /**
     * Reads a JSON array object (a results part): its first `limit` items and how many it holds
     * in all. An absent or unreadable object reads as empty.
     */
    readItems: {
      args: { key: Schema.String, limit: Schema.Number },
      success: { items: Schema.Array(Schema.Json), total: Schema.Number },
    },
    /** Writes a JSON object and reports its size. */
    writeJson: {
      args: { key: Schema.String, value: Schema.Json },
      success: { bytes: Schema.Number },
    },
    remove: { args: { keys: Schema.Array(Schema.String) }, success: {} },
    /**
     * A link to PUT exactly this body (size, SHA-256 hex digest, content type) to `key`, valid
     * for `seconds`. The client sends every header in `headers` with the PUT, as given.
     */
    presignPut: {
      args: {
        key: Schema.String,
        mime: Schema.String,
        bytes: Schema.Number,
        sha256: Schema.String,
        seconds: Schema.Number,
      },
      success: { url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) },
    },
    /**
     * A link to GET `key`, valid for `seconds`, served as `mime` (named `name` when it is
     * downloaded), on the artifact origin and never inline as active content.
     */
    presignGet: {
      args: {
        key: Schema.String,
        mime: Schema.String,
        name: Schema.NullOr(Schema.String),
        seconds: Schema.Number,
      },
      success: { url: Schema.String },
    },
  },
  { description: "Artifact and results object storage (R2)." },
) {}
