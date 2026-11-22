import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ServerConfig } from "./ServerConfig.ts";

/**
 * Signed GET links on the artifact origin: `<artifactOrigin>/o/<key>?m=<type>&n=<name>&e=<expiry>&s=<mac>`.
 * The MAC (HMAC-SHA-256 over key, type, name and expiry) binds what the domain decided: which
 * object, served as which type, until when.
 */

/** A GET link the artifact origin will serve. */
export interface LinkClaims {
  readonly key: string;
  readonly mime: string;
  readonly name: string | null;
  /** Epoch milliseconds after which the link is refused. */
  readonly expires: number;
}

/** The link's signature does not match its parameters. */
export class LinkForged extends Schema.TaggedError<LinkForged>()("LinkForged", {}) {}

/** The link's expiry passed. */
export class LinkExpired extends Schema.TaggedError<LinkExpired>()("LinkExpired", {}) {}

export class Links extends Context.Service<
  Links,
  {
    readonly sign: (request: {
      readonly key: string;
      readonly mime: string;
      readonly name: string | null;
      readonly seconds: number;
    }) => Effect.Effect<string>;
    readonly verify: (url: URL) => Effect.Effect<LinkClaims, LinkForged | LinkExpired>;
  }
>()("Console/Links") {}

const encoder = new TextEncoder();
const prefix = "/o/";

const message = (claims: LinkClaims) =>
  encoder.encode(JSON.stringify([claims.key, claims.mime, claims.name ?? "", claims.expires]));

/** Links signed with `HIGHALCH_LINK_SECRET` for `HIGHALCH_ARTIFACT_ORIGIN`. */
export const layer = Layer.effect(
  Links,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const mac = yield* Mac.Mac;
    const key = yield* Mac.key(
      Mac.hmacSha256,
      encoder.encode(Redacted.value(config.linkSecret)),
    ).pipe(Effect.orDie);
    const signature = (claims: LinkClaims) =>
      Effect.map(mac.sign(key, message(claims)), Base64Url.encode);
    return Links.of({
      sign: Effect.fn("Links.sign")(function* ({ key: object, mime, name, seconds }) {
        const claims = {
          key: object,
          mime,
          name,
          expires: (yield* Clock.currentTimeMillis) + seconds * 1000,
        };
        const url = new URL(
          `${prefix}${object.split("/").map(encodeURIComponent).join("/")}`,
          config.artifactOrigin,
        );
        url.searchParams.set("m", mime);
        if (name !== null) url.searchParams.set("n", name);
        url.searchParams.set("e", String(claims.expires));
        url.searchParams.set("s", yield* signature(claims));
        return url.toString();
      }, Effect.orDie),
      verify: Effect.fn("Links.verify")(function* (url: URL) {
        const claims: LinkClaims = {
          key: decodeURIComponent(url.pathname.slice(prefix.length)),
          mime: url.searchParams.get("m") ?? "",
          name: url.searchParams.get("n"),
          expires: Number(url.searchParams.get("e")),
        };
        const tag = Result.getOrUndefined(Base64Url.decode(url.searchParams.get("s") ?? ""));
        const valid =
          url.pathname.startsWith(prefix) &&
          tag !== undefined &&
          (yield* mac.verify(key, tag, message(claims)).pipe(Effect.orDie));
        if (!valid) return yield* new LinkForged();
        if (!(claims.expires > (yield* Clock.currentTimeMillis))) return yield* new LinkExpired();
        return claims;
      }),
    });
  }),
);
