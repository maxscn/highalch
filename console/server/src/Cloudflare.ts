import * as Cloudflare from "@alchemy.run/cloudflare";
import { presignR2Url } from "@alchemy.run/cloudflare/R2/PresignToken";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ambient } from "./Ambient.ts";
import { Bucket, BucketUnavailable } from "./Bucket.ts";
import { budgets, RateLimit, RequestBudgetSpent, type Budget } from "./RateLimit.ts";

/** Artifact bodies and results objects. CI and browsers PUT to signed links directly. */
export const Artifacts = Cloudflare.R2.Bucket("Artifacts", {
  cors: [
    {
      allowedMethods: ["PUT"],
      allowedOrigins: ["*"],
      allowedHeaders: ["content-type", "content-length", "x-amz-checksum-sha256"],
    },
  ],
});

/** Better Auth's users, sessions and accounts. */
export const AuthDb = Cloudflare.D1.Database("AuthDb");

const unavailable = (operation: string) => (cause: { readonly message: string }) =>
  new BucketUnavailable({ operation, message: cause.message });

/**
 * `Bucket` over R2: objects through the native binding, PUT links signed with the bucket's S3
 * credentials (SigV4 over every header given; under `alchemy dev` the local S3 endpoint).
 */
export const bucket = Layer.effect(
  Bucket,
  Effect.gen(function* () {
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(Artifacts);
    const s3 = yield* Cloudflare.R2.S3Credentials(Artifacts, { access: "write" });
    return Bucket.of({
      head: (key) =>
        r2.head(key).pipe(
          Effect.map((object) =>
            Option.map(Option.fromNullishOr(object), (o) => ({
              size: o.size,
              sha256: Option.map(Option.fromNullishOr(o.checksums.sha256), (digest) =>
                Hex.encode(new Uint8Array(digest)),
              ),
            })),
          ),
          Effect.mapError(unavailable("head")),
          ambient,
        ),
      get: (key) =>
        r2.get(key).pipe(
          Effect.map((object) =>
            Option.map(Option.fromNullishOr(object), (o) => ({
              size: o.size,
              stream: o.body.pipe(Stream.mapError(unavailable("get"))),
              bytes: o.bytes().pipe(Effect.mapError(unavailable("get"))),
            })),
          ),
          Effect.mapError(unavailable("get")),
          ambient,
        ),
      put: (key, body, contentType) =>
        r2
          .put(key, body, { httpMetadata: { contentType } })
          .pipe(Effect.asVoid, Effect.mapError(unavailable("put")), ambient),
      remove: (keys) => r2.delete([...keys]).pipe(Effect.mapError(unavailable("delete")), ambient),
      presignPut: ({ key, headers, seconds }) =>
        Effect.flatMap(s3, (credentials) =>
          presignR2Url(credentials, {
            method: "PUT",
            key,
            expiresIn: seconds,
            headers: { ...headers },
          }),
        ).pipe(Effect.mapError(unavailable("presign")), ambient),
    });
  }),
);

/** `RateLimit` over Cloudflare Rate Limiting: one binding per budget (per 60 s). */
export const rateLimit = Layer.effect(
  RateLimit,
  Effect.gen(function* () {
    const limiters = {
      ci: yield* Cloudflare.RateLimit("LIMIT_CI", {
        namespaceId: 7_101,
        simple: { limit: budgets.ci, period: 60 },
      }),
      session: yield* Cloudflare.RateLimit("LIMIT_SESSION", {
        namespaceId: 7_102,
        simple: { limit: budgets.session, period: 60 },
      }),
      address: yield* Cloudflare.RateLimit("LIMIT_ADDRESS", {
        namespaceId: 7_103,
        simple: { limit: budgets.address, period: 60 },
      }),
    } satisfies Record<Budget, unknown>;
    return RateLimit.of({
      spend: (budget, key) =>
        limiters[budget].limit({ key }).pipe(
          // an unavailable limiter fails closed
          Effect.orElseSucceed(() => ({ success: false })),
          Effect.flatMap(({ success }) =>
            success ? Effect.void : Effect.fail(new RequestBudgetSpent({ budget, retryAfter: 60 })),
          ),
          ambient,
        ),
    });
  }),
);
