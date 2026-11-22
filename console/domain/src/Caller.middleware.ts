import * as Schema from "effect/Schema";
import { RpcMiddleware } from "effect/rpc";
import { CurrentActor } from "./CurrentActor.context.ts";

/** The request carries no session cookie and no bearer token. */
export class CredentialMissing extends Schema.TaggedError<CredentialMissing>()(
  "CredentialMissing",
  {},
  { httpApiStatus: 401 },
) {}

/** The session cookie names no current session. */
export class SessionInvalid extends Schema.TaggedError<SessionInvalid>()(
  "SessionInvalid",
  {},
  { httpApiStatus: 401 },
) {}

/** The bearer token looks like an API key but is malformed, unknown or revoked. */
export class ApiKeyInvalid extends Schema.TaggedError<ApiKeyInvalid>()(
  "ApiKeyInvalid",
  {},
  { httpApiStatus: 401 },
) {}

/** The bearer token is not a valid GitHub Actions OIDC token for this audience. */
export class OidcTokenInvalid extends Schema.TaggedError<OidcTokenInvalid>()(
  "OidcTokenInvalid",
  {},
  { httpApiStatus: 401 },
) {}

/** A valid GitHub OIDC token whose repository no project is bound to. */
export class RepositoryNotBound extends Schema.TaggedError<RepositoryNotBound>()(
  "RepositoryNotBound",
  { repository: Schema.String },
  { httpApiStatus: 403 },
) {}

/** Every way authenticating a request fails. */
export const CallerError = Schema.Union([
  CredentialMissing,
  SessionInvalid,
  ApiKeyInvalid,
  OidcTokenInvalid,
  RepositoryNotBound,
]);
export type CallerError = typeof CallerError.Type;

/**
 * Authenticates the caller and provides who it is (`CurrentActor`) to every command, query and
 * feed read. `CallerLive` (Authentication.ts) implements it from the request's credential: a
 * browser session, a project API key or a GitHub Actions OIDC token. Trusted server code
 * provides a fixed actor instead.
 */
export class Caller extends RpcMiddleware.Service<Caller, { provides: CurrentActor }>()(
  "Console/Caller",
  { error: CallerError },
) {}
