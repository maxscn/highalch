import { ConsoleApi } from "@highalch/console-domain/Console.api";
import { oidcAudience } from "@highalch/console-domain/Credentials";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  OidcTokenUnavailable,
  RateLimited,
  ServerUnreachable,
  UnexpectedResponse,
} from "./Errors.ts";

/** How a CI run proves who it is. */
export type Credential =
  /** A project API key (`highalch_live_…`). */
  | { readonly _tag: "ApiKey"; readonly token: Redacted.Redacted<string> }
  /** GitHub Actions' ID token endpoint (`ACTIONS_ID_TOKEN_REQUEST_*`), asked for audience `highalch`. */
  | {
      readonly _tag: "GithubActions";
      readonly url: string;
      readonly token: Redacted.Redacted<string>;
    };

/** Attempts per request including the first, and the first backoff. */
export interface RetryOptions {
  readonly attempts: number;
  readonly delay: Duration.Input;
}

/** Exponential, jittered backoff; `Retry-After` is honoured by HttpClient. */
export const backoff = (retry: RetryOptions) =>
  Schedule.exponential(retry.delay).pipe(Schedule.jittered);

/** An HttpClient that retries network failures, 429 and 5xx, and fails on any other non-2xx. */
export const retrying = (client: HttpClient.HttpClient, retry: RetryOptions) =>
  client.pipe(
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      schedule: backoff(retry),
      times: Math.max(0, retry.attempts - 1),
    }),
  );

/** GitHub ID tokens live a few minutes; one older than this is asked for again. */
const oidcTokenAge = Duration.minutes(4);

const IdToken = Schema.Struct({ value: Schema.String.check(Schema.isNonEmpty()) });

/** Asks GitHub Actions for an ID token with audience `highalch`. */
const requestIdToken = (
  http: HttpClient.HttpClient,
  credential: Extract<Credential, { _tag: "GithubActions" }>,
) =>
  Effect.gen(function* () {
    const url = new URL(credential.url);
    url.searchParams.set("audience", oidcAudience);
    const response = yield* http.execute(
      HttpClientRequest.get(url.toString()).pipe(
        HttpClientRequest.bearerToken(Redacted.value(credential.token)),
      ),
    );
    const body = yield* Effect.flatMap(response.json, Schema.decodeUnknownEffect(IdToken));
    return Redacted.make(body.value);
  }).pipe(
    Effect.catchTags({
      HttpClientError: (error) =>
        Effect.fail(
          new OidcTokenUnavailable({
            status: error.reason._tag === "StatusCodeError" ? error.reason.response.status : null,
            message: error.message,
          }),
        ),
      SchemaError: (error) =>
        Effect.fail(new OidcTokenUnavailable({ status: null, message: error.message })),
    }),
  );

/**
 * The bearer token of every call: an API key as given, a GitHub ID token asked for once and
 * again when it is older than a few minutes (`refresh` before each operation).
 */
const bearerOf = Effect.fn("Connection.bearer")(function* (
  http: HttpClient.HttpClient,
  credential: Credential,
) {
  if (credential._tag === "ApiKey") {
    const token = yield* Ref.make(credential.token);
    return { token, refresh: Effect.void };
  }
  const first = yield* requestIdToken(http, credential);
  const token = yield* Ref.make(first);
  const askedAt = yield* Ref.make(yield* Clock.currentTimeMillis);
  const refresh = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - (yield* Ref.get(askedAt)) < Duration.toMillis(oidcTokenAge)) return;
    yield* Ref.set(token, yield* requestIdToken(http, credential));
    yield* Ref.set(askedAt, now);
  });
  return { token, refresh };
});

/** The ConsoleApi client the upload flow uses. */
export type Api = typeof ConsoleApi.Client.Service;

/**
 * Connects to HighAlch Console's Api at `<url>/api/console` over HTTP with the credential as
 * bearer token. Requests are retried on network failures, 429 and 5xx (`retry`).
 */
export const connect = Effect.fn("Connection.connect")(function* (
  url: string,
  credential: Credential,
  retry: RetryOptions,
) {
  const http = yield* HttpClient.HttpClient;
  const bearer = yield* bearerOf(retrying(http, retry), credential);
  const authenticated = retrying(
    HttpClient.mapRequestEffect(http, (request) =>
      Effect.map(Ref.get(bearer.token), (token) =>
        HttpClientRequest.bearerToken(request, Redacted.value(token)),
      ),
    ),
    retry,
  );
  const api = yield* ConsoleApi.clientHttp(`${url.replace(/\/+$/, "")}/api/console`).pipe(
    Effect.provideService(HttpClient.HttpClient, authenticated),
  );
  /**
   * Runs one Api call as `operation`: refreshes the credential first, and turns transport
   * failures that outlived the retries into the client's own errors.
   */
  const call = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    Effect.andThen(bearer.refresh, effect).pipe(
      Effect.mapError((error: unknown) =>
        isRpcClientError(error) ? transportFailure(operation, error) : error,
      ),
    ) as Effect.Effect<
      A,
      | Exclude<E, { readonly _tag: "RpcClientError" }>
      | OidcTokenUnavailable
      | RateLimited
      | ServerUnreachable
      | UnexpectedResponse,
      R
    >;
  return { api, call };
});

export type Connection = Effect.Success<ReturnType<typeof connect>>;

interface RpcClientErrorLike {
  readonly _tag: "RpcClientError";
  readonly reason: {
    readonly _tag: string;
    readonly message: string;
    readonly response?: { readonly status: number };
  };
}

const isRpcClientError = (error: unknown): error is RpcClientErrorLike =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "RpcClientError";

const transportFailure = (operation: string, error: RpcClientErrorLike) => {
  const reason = error.reason;
  if (reason._tag === "StatusCodeError" && reason.response?.status === 429)
    return new RateLimited({ operation });
  if (reason._tag === "RpcClientDefect")
    return new UnexpectedResponse({ operation, message: reason.message });
  return new ServerUnreachable({ operation, message: reason.message });
};
