import { createAuthClient } from "better-auth/client";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * Sign-in and sign-out through Better Auth's own client, on this origin's `/api/auth` (the
 * Worker in production, the in-memory dev backend under `vp dev`). Its session cookie,
 * `highalch_session`, is what the Console Api's `Caller` reads. Each failure is a tagged error.
 */
const auth = createAuthClient({
  baseURL: typeof window === "undefined" ? "http://localhost" : window.location.origin,
  basePath: "/api/auth",
});

/** The email and password match no account. */
export class InvalidCredentials extends Data.TaggedError("InvalidCredentials")<{}> {}

/** This Console has no such sign-in provider set up. */
export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<{
  readonly provider: string;
}> {}

/** Better Auth did not answer as expected (offline, a server error). */
export class AuthUnreachable extends Data.TaggedError("AuthUnreachable")<{
  readonly status: number;
  readonly message: string;
}> {}

type AuthResult = {
  readonly error: {
    readonly status: number;
    readonly code?: string | undefined;
    readonly message?: string | undefined;
  } | null;
};

const failureOf = (error: NonNullable<AuthResult["error"]>, provider?: string) => {
  if (error.code === "INVALID_EMAIL_OR_PASSWORD") return new InvalidCredentials();
  if (provider !== undefined && (error.code === "PROVIDER_NOT_FOUND" || error.status === 404))
    return new ProviderUnavailable({ provider });
  return new AuthUnreachable({ status: error.status, message: error.message ?? "" });
};

const call = <A extends AuthResult>(run: () => Promise<A>, provider?: string) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AuthUnreachable({ status: 0, message: String(cause) }),
  }).pipe(
    Effect.flatMap((result) =>
      result.error === null
        ? Effect.succeed(result)
        : Effect.fail(failureOf(result.error, provider)),
    ),
  );

export const signInWithEmail = (email: string, password: string) =>
  Effect.asVoid(call(() => auth.signIn.email({ email, password, rememberMe: true })));

/** Starts GitHub sign-in; Better Auth redirects the page and comes back to `callbackURL`. */
export const signInWithGithub = (callbackURL: string) =>
  Effect.asVoid(call(() => auth.signIn.social({ provider: "github", callbackURL }), "github"));

export const signOut = Effect.asVoid(call(() => auth.signOut()));
