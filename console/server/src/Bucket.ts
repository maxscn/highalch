import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

/** The object store did not answer (R2 unavailable, a binding failure). */
export class BucketUnavailable extends Schema.TaggedError<BucketUnavailable>()(
  "BucketUnavailable",
  { operation: Schema.String, message: Schema.String },
) {}

/** What a stored object's metadata says about it. */
export interface Head {
  readonly size: number;
  /** Lowercase hex SHA-256 the upload was checked against, when it carried one. */
  readonly sha256: Option.Option<string>;
}

/** A stored object's body. */
export interface Body {
  readonly size: number;
  readonly stream: Stream.Stream<Uint8Array, BucketUnavailable>;
  readonly bytes: Effect.Effect<Uint8Array, BucketUnavailable>;
}

/**
 * The artifact bucket (R2), as `Storage` and the artifact origin use it: objects by key, and PUT
 * links signed over exact headers. `Cloudflare.ts` implements it with alchemy's R2 bindings.
 */
export class Bucket extends Context.Service<
  Bucket,
  {
    readonly head: (key: string) => Effect.Effect<Option.Option<Head>, BucketUnavailable>;
    readonly get: (key: string) => Effect.Effect<Option.Option<Body>, BucketUnavailable>;
    readonly put: (
      key: string,
      body: Uint8Array,
      contentType: string,
    ) => Effect.Effect<void, BucketUnavailable>;
    readonly remove: (keys: ReadonlyArray<string>) => Effect.Effect<void, BucketUnavailable>;
    /**
     * A URL to PUT `key` with exactly these headers (each one is signed into the URL), valid for
     * `seconds`.
     */
    readonly presignPut: (request: {
      readonly key: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly seconds: number;
    }) => Effect.Effect<string, BucketUnavailable>;
  }
>()("Console/Bucket") {}
