import { GithubClaims, GithubOidc } from "@highalch/console-domain/Authentication";
import { oidcAudience } from "@highalch/console-domain/Credentials";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Jwks from "effect/jose/Jwks";
import * as Jwt from "effect/jose/Jwt";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** GitHub Actions' OIDC issuer and its signing keys. */
export const issuer = "https://token.actions.githubusercontent.com";
export const jwksUrl = `${issuer}/.well-known/jwks`;

/**
 * The domain's `GithubOidc`: a token is valid when a key of GitHub's JWKS signed it (RS256),
 * GitHub issued it, its audience is `highalch` and it has not expired (60 s clock tolerance).
 * Anything else verifies as none; GitHub's key set being unreachable is a defect (the request
 * fails with 500 and CI retries it), never an accepted or a refused token.
 */
export const layer = Layer.effect(
  GithubOidc,
  Effect.gen(function* () {
    const context = yield* Effect.context<Jwks.Jwks | Signature.Signature>();
    return GithubOidc.of({
      verify: (token) =>
        Jwt.verifyWithKeySet(GithubClaims, token, {
          algorithms: ["RS256"],
          issuer,
          audience: oidcAudience,
          requiredClaims: ["exp"],
          clockTolerance: "60 seconds",
        }).pipe(
          Effect.map((verified) => Option.some(verified.claims)),
          Effect.catch((error) =>
            error._tag === "JoseError" && error.reason._tag === "KeySetUnavailable"
              ? Effect.die(error)
              : Effect.succeed(Option.none()),
          ),
          Effect.provideContext(context),
        ),
    });
  }),
);

/** GitHub's key set over HTTP (cached by `Jwks`), refusing redirects. */
export const remoteKeySet = Jwks.layerRemote({ url: jwksUrl }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
  // its options are constants: a construction failure is a bug
  Layer.orDie,
);

/** The domain's `GithubOidc` against GitHub's published keys. */
export const live = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      remoteKeySet,
      Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)),
    ),
  ),
);
