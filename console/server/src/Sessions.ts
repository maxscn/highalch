import { Sessions, type SessionUser } from "@highalch/console-domain/Authentication";
import { sessionCookie } from "@highalch/console-domain/Credentials";
import { UserId } from "@highalch/console-domain/Ids";
import * as Context from "effect/Context";
import type { HttpEffect } from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/** The part of a Better Auth instance (`@alchemy.run/better-auth`) that resolves sessions. */
export interface SessionSource {
  readonly getSession: (headers: Headers) => Effect.Effect<
    {
      readonly user: {
        readonly id: string;
        readonly email: string;
        readonly name?: string | null | undefined;
      };
    } | null,
    unknown,
    never
  >;
}

/** The Worker's Better Auth instance: its routes, and sessions as the adapter reads them. */
export class Auth extends Context.Service<
  Auth,
  SessionSource & {
    readonly fetch: HttpEffect;
  }
>()("Console/Auth") {}

/**
 * The domain's `Sessions` over Better Auth: the `highalch_session` cookie's token is Better
 * Auth's session token (Better Auth is configured to name its cookie so). A token Better Auth
 * does not know, or one it refuses, is no session.
 */
export const layer = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const auth = yield* Auth;
    return Sessions.of({
      user: (token) =>
        auth.getSession(new Headers({ cookie: `${sessionCookie}=${Redacted.value(token)}` })).pipe(
          Effect.map((session) =>
            Option.map(Option.fromNullishOr(session), (s): SessionUser => ({
              id: UserId.make(s.user.id),
              email: s.user.email,
              name: s.user.name ?? null,
            })),
          ),
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning("session lookup refused").pipe(
                Effect.annotateLogs({ error: String(error) }),
              ),
              Option.none<SessionUser>(),
            ),
          ),
        ),
    });
  }),
);
