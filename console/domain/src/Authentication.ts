import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { Actor } from "./Actor.ts";
import {
  ApiKeyInvalid,
  Caller,
  CredentialMissing,
  OidcTokenInvalid,
  RepositoryNotBound,
  SessionInvalid,
  type CallerError,
} from "./Caller.middleware.ts";
import { credentialOf, parseApiKey, type Credential } from "./Credentials.ts";
import { CurrentActor } from "./CurrentActor.context.ts";
import { UserId } from "./Ids.ts";
import { UserOrganizations } from "./Organization/UserOrganizations.view.ts";
import { Project } from "./Project/Project.aggregate.ts";
import { ProjectId, RepositoryId } from "./Project/Project.id.ts";
import { Repository } from "./Project/Repository.aggregate.ts";

// ---------------------------------------------------------------- what the server provides

/** Who a session belongs to, as the identity provider (Better Auth) knows them. */
export const SessionUser = Schema.Struct({
  id: UserId,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
});
export type SessionUser = typeof SessionUser.Type;

/** Resolves a session token to its user (Better Auth). Provided by the server. */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** The session's user, or none when the token names no current session. */
    readonly user: (token: Redacted.Redacted<string>) => Effect.Effect<Option.Option<SessionUser>>;
  }
>()("Console/Sessions") {}

/** The claims of a verified GitHub Actions OIDC token that authorisation reads. */
export const GithubClaims = Schema.Struct({
  repository: Schema.String,
  sha: Schema.String,
  ref: Schema.String,
  head_ref: Schema.optionalKey(Schema.String),
  base_ref: Schema.optionalKey(Schema.String),
  ref_name: Schema.optionalKey(Schema.String),
});
export type GithubClaims = typeof GithubClaims.Type;

/**
 * Verifies a GitHub Actions OIDC token: signed by a key of GitHub's JWKS, issued by GitHub, for
 * `oidcAudience`, not expired. Provided by the server.
 */
export class GithubOidc extends Context.Service<
  GithubOidc,
  {
    /** The token's claims, or none when it is not a valid token for this audience. */
    readonly verify: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<Option.Option<GithubClaims>>;
  }
>()("Console/GithubOidc") {}

// ---------------------------------------------------------------- authentication

/** Commit, branch, PR and base branch from verified claims. */
export const contextOf = (claims: GithubClaims) => {
  const pull = /^refs\/pull\/(\d+)\//.exec(claims.ref);
  const branch =
    (claims.head_ref && claims.head_ref !== "" ? claims.head_ref : undefined) ??
    claims.ref_name ??
    claims.ref.replace(/^refs\/(heads|tags)\//, "");
  return {
    commit: claims.sha,
    branch,
    pr: pull?.[1] ? Number(pull[1]) : null,
    baseBranch: claims.base_ref && claims.base_ref !== "" ? claims.base_ref : null,
  };
};

/** Who a credential belongs to. */
export class Authenticator extends Context.Service<
  Authenticator,
  { readonly actorOf: (credential: Credential) => Effect.Effect<Actor, CallerError> }
>()("Console/Authenticator") {}

const encoder = new TextEncoder();

/**
 * Resolves credentials against the model: a session's memberships, an API key's project (its
 * hash must match a key the project issued and has not revoked), a GitHub OIDC token's
 * repository binding. Verification of what only the server can verify sits behind `Sessions`,
 * `GithubOidc` and `Digest`.
 */
export const AuthenticatorLive = Layer.effect(
  Authenticator,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const oidc = yield* GithubOidc;
    const digest = yield* Digest.Digest;
    const projects = yield* Project;
    const repositories = yield* Repository;
    const memberships = yield* UserOrganizations;

    const session = Effect.fn("Authenticate.session")(function* (token: Redacted.Redacted<string>) {
      const user = yield* sessions.user(token);
      if (Option.isNone(user)) return yield* new SessionInvalid();
      // reading without `atLeast` cannot time out
      const joined = yield* memberships.get(user.value.id).pipe(Effect.orDie);
      return {
        _tag: "User",
        user: user.value.id,
        email: user.value.email,
        name: user.value.name,
        memberships: Option.match(joined, {
          onNone: () => [],
          onSome: (state) => state.organizations.map(({ org, role }) => ({ org, role })),
        }),
      } satisfies Actor;
    });

    const apiKey = Effect.fn("Authenticate.apiKey")(function* (token: Redacted.Redacted<string>) {
      const parsed = parseApiKey(Redacted.value(token));
      if (Option.isNone(parsed)) return yield* new ApiKeyInvalid();
      const project = yield* projects.get(ProjectId.make(parsed.value.project));
      if (project._tag !== "Active") return yield* new ApiKeyInvalid();
      const hash = yield* digest.digestHex(Digest.sha256, encoder.encode(Redacted.value(token)));
      const record = project.keys.find((k) => k.key === parsed.value.keyId && k.hash === hash);
      if (record === undefined) return yield* new ApiKeyInvalid();
      return {
        _tag: "Key",
        org: project.org,
        project: ProjectId.make(parsed.value.project),
        key: record.key,
      } satisfies Actor;
    });

    const githubOidc = Effect.fn("Authenticate.githubOidc")(function* (
      token: Redacted.Redacted<string>,
    ) {
      const claims = yield* oidc.verify(token);
      if (Option.isNone(claims)) return yield* new OidcTokenInvalid();
      const repository = claims.value.repository.toLowerCase();
      const binding = yield* repositories.get(RepositoryId.make(repository));
      if (binding._tag !== "Claimed") return yield* new RepositoryNotBound({ repository });
      return {
        _tag: "Uploader",
        org: binding.org,
        project: binding.project,
        run: null,
        context: contextOf(claims.value),
      } satisfies Actor;
    });

    return Authenticator.of({
      actorOf: (credential) => {
        switch (credential._tag) {
          case "Session":
            return session(credential.token);
          case "ApiKey":
            return apiKey(credential.token);
          case "GithubOidc":
            return githubOidc(credential.token);
        }
      },
    });
  }),
);

/**
 * The `Caller` middleware: authenticates each request from its credential and provides the
 * actor. Requires the hosted model (projects, repositories, memberships) and the server's
 * `Sessions`, `GithubOidc` and `Digest`.
 */
export const CallerLive = Layer.effect(
  Caller,
  Effect.map(
    Authenticator,
    (authenticator) => (effect, options) =>
      Effect.flatMap(
        Option.match(credentialOf(options.headers), {
          onNone: () => Effect.fail(new CredentialMissing()),
          onSome: authenticator.actorOf,
        }),
        (actor) => Effect.provideService(effect, CurrentActor, actor),
      ),
  ),
).pipe(Layer.provide(AuthenticatorLive));
