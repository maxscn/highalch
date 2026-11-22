import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import type * as Headers from "effect/http/Headers";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ProjectId } from "./Project/Project.id.ts";

/**
 * The names a credential is recognised by. Each one is a decision of the product owner, kept
 * here so that changing it is one line.
 */

/** Every project API key starts with it: `highalch_live_<project>.<keyId>.<secret>`. */
export const apiKeyPrefix = "highalch_live_";

/** The audience CI requests GitHub Actions OIDC tokens for, and the only one accepted. */
export const oidcAudience = "highalch";

/** The browser session cookie (Better Auth's session token). */
export const sessionCookie = "highalch_session";

/** A credential a request carries, before anything has verified it. */
export const Credential = Schema.Union([
  Schema.TaggedStruct("Session", { token: Schema.Redacted(Schema.String) }),
  Schema.TaggedStruct("ApiKey", { token: Schema.Redacted(Schema.String) }),
  Schema.TaggedStruct("GithubOidc", { token: Schema.Redacted(Schema.String) }),
]);
export type Credential = typeof Credential.Type;

const bearerOf = (authorization: string) =>
  Option.fromNullishOr(/^Bearer\s+(\S+)\s*$/i.exec(authorization)?.[1]);

const cookieOf = (cookies: string) =>
  Option.fromNullishOr(
    cookies
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${sessionCookie}=`))
      ?.slice(sessionCookie.length + 1),
  ).pipe(Option.filter((token) => token.length > 0));

/** A bearer token is an API key when it has the key prefix, else a GitHub OIDC token. */
const fromBearer = (token: string): Credential =>
  token.startsWith(apiKeyPrefix)
    ? { _tag: "ApiKey", token: Redacted.make(token) }
    : { _tag: "GithubOidc", token: Redacted.make(token) };

/**
 * The credential of a request: its bearer token (CI: an API key or a GitHub OIDC token), else
 * its session cookie (browsers).
 */
export const credentialOf = (headers: Headers.Headers): Option.Option<Credential> =>
  Option.orElse(
    Option.map(
      Option.flatMap(Option.fromNullishOr(headers["authorization"]), bearerOf),
      fromBearer,
    ),
    () =>
      Option.map(
        Option.flatMap(Option.fromNullishOr(headers["cookie"]), cookieOf),
        (token): Credential => ({ _tag: "Session", token: Redacted.make(token) }),
      ),
  );

// ---------------------------------------------------------------- API keys

/** A project API key's bearer token: `highalch_live_<base64url project>.<keyId>.<secret>`. */
export const formatApiKey = (project: string, keyId: string, secret: string) =>
  `${apiKeyPrefix}${Base64Url.encode(project)}.${keyId}.${secret}`;

/** The project and key id a key names, if it is shaped like one. */
export const parseApiKey = (
  token: string,
): Option.Option<{ readonly project: string; readonly keyId: string }> => {
  const parts = token.startsWith(apiKeyPrefix) ? token.slice(apiKeyPrefix.length).split(".") : [];
  const [project, keyId, secret] = parts;
  if (parts.length !== 3 || !project || !keyId || !secret) return Option.none();
  return Option.map(Result.getSuccess(Base64Url.decode(project)), (bytes) => ({
    project: new TextDecoder().decode(bytes),
    keyId,
  }));
};

/** What a key list shows of a key: everything but its secret. */
export const displayPrefix = (token: string) => token.split(".").slice(0, 2).join(".");

/**
 * A new API key for `project`, made where it is shown (the browser): its token, shown once, and
 * the `IssueApiKey` input, which carries only the key's id, prefix and SHA-256 hash.
 */
export const makeApiKey = Effect.fn("makeApiKey")(function* (project: ProjectId, name: string) {
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const key = Hex.encode(yield* random.randomBytes(8));
  const token = formatApiKey(project, key, Base64Url.encode(yield* random.randomBytes(32)));
  const hash = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(token));
  return {
    token: Redacted.make(token),
    input: { project, key, name, prefix: displayPrefix(token), hash },
  };
});
