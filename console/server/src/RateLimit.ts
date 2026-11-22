import { GithubOidc } from "@highalch/console-domain/Authentication";
import { plans } from "@highalch/console-domain/Billing/Plan";
import { credentialOf, parseApiKey } from "@highalch/console-domain/Credentials";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * Fixed request budgets per minute, per credential, enforced before a request reaches
 * `ConsoleApi` (owner decision 3A): CI per API key or per GitHub repository (the verified OIDC
 * token's), browsers per session, everything else per client address. CI gets the largest plan's
 * API budget; the per-plan budgets of `Billing/Plan.ts` would need the model.
 */
export const budgets = {
  /** An API key or a repository's OIDC tokens: the largest plan's API budget. */
  ci: Math.max(...plans.map((plan) => plan.limits.requestsPerMinute)),
  /**
   * A browser session: far above what the web app makes in normal use (live reads reconnect,
   * link queries per opened run), so only abuse meets it. The cost model assumes
   * `workload.sessionRequestsPerMinute` (20) on average, not as a cap.
   */
  session: 600,
  /** Requests without a credential, or with one that does not verify: per address. */
  address: 30,
} as const;

export type Budget = keyof typeof budgets;

/** The budget a request spends from was used up. */
export class RequestBudgetSpent extends Schema.TaggedError<RequestBudgetSpent>()(
  "RequestBudgetSpent",
  { budget: Schema.String, retryAfter: Schema.Number },
) {}

/** Per-key counters of one budget (Cloudflare Rate Limiting bindings in the Worker). */
export class RateLimit extends Context.Service<
  RateLimit,
  { readonly spend: (budget: Budget, key: string) => Effect.Effect<void, RequestBudgetSpent> }
>()("Console/RateLimit") {}

const encoder = new TextEncoder();

/**
 * The budget and key of a request: an API key by its key id (and a digest of the token, so a
 * forged token naming a key id cannot spend that key's budget), an OIDC token by the repository
 * it verifies for, a session by a digest of its token, anything else by address.
 */
export const budgetOf = Effect.fn("RateLimit.budgetOf")(function* (
  headers: HttpServerRequest.HttpServerRequest["headers"],
) {
  const digest = yield* Digest.Digest;
  const oidc = yield* GithubOidc;
  const hashOf = (token: Redacted.Redacted<string>) =>
    Effect.map(digest.digestHex(Digest.sha256, encoder.encode(Redacted.value(token))), (hex) =>
      hex.slice(0, 32),
    );
  const address = {
    budget: "address" as const,
    key: `ip:${headers["cf-connecting-ip"] ?? "local"}`,
  };
  const credential = credentialOf(headers);
  if (Option.isNone(credential)) return address;
  switch (credential.value._tag) {
    case "ApiKey": {
      const parsed = parseApiKey(Redacted.value(credential.value.token));
      if (Option.isNone(parsed)) return address;
      return {
        budget: "ci" as const,
        key: `key:${parsed.value.project}.${parsed.value.keyId}:${yield* hashOf(credential.value.token)}`,
      };
    }
    case "GithubOidc": {
      const claims = yield* oidc.verify(credential.value.token);
      return Option.isSome(claims)
        ? { budget: "ci" as const, key: `repo:${claims.value.repository.toLowerCase()}` }
        : address;
    }
    case "Session":
      return {
        budget: "session" as const,
        key: `session:${yield* hashOf(credential.value.token)}`,
      };
  }
});

/** Runs `effect` when the request's budget allows it; answers 429 with `Retry-After` otherwise. */
export const limited = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const limit = yield* RateLimit;
    const { budget, key } = yield* budgetOf(request.headers);
    const spent = yield* Effect.result(limit.spend(budget, key));
    if (Result.isFailure(spent))
      return HttpServerResponse.text("Too many requests", {
        status: 429,
        headers: { "retry-after": String(spent.failure.retryAfter) },
      });
    return yield* effect;
  });
