import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Bucket } from "./Bucket.ts";
import { Links } from "./Links.ts";
import { ServerConfig } from "./ServerConfig.ts";

/**
 * Types served inline: passive media and text only. Everything else (HTML, SVG, XML, scripts,
 * PDFs, unknown types) is active or may be, and is served as an `application/octet-stream`
 * attachment: nothing uploaded ever runs, on any origin.
 */
export const inlineTypes: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/webm",
  "video/mp4",
  "text/plain",
  "application/json",
]);

/** The headers every body leaves the artifact origin with. */
export const securityHeaders = (
  mime: string,
  name: string | null,
  appOrigin: string,
): Record<string, string> => {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const inline = inlineTypes.has(base);
  const filename = (name ?? "artifact").replace(/[^\w.-]+/g, "_").slice(0, 200) || "artifact";
  return {
    "content-type": inline
      ? base.startsWith("text/") || base === "application/json"
        ? `${base}; charset=utf-8`
        : base
      : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
    "content-security-policy": "sandbox; default-src 'none'; img-src data:; media-src 'self'",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "cross-origin",
    "access-control-allow-origin": appOrigin,
    "referrer-policy": "no-referrer",
    "cache-control": "private, max-age=60",
  };
};

const refused = (status: number, text: string) =>
  HttpServerResponse.text(text, {
    status,
    headers: { "x-content-type-options": "nosniff", "cache-control": "no-store" },
  });

/** `true` when the request is for the artifact origin (by its Host). */
export const isArtifactHost = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig;
  return request.headers.host === new URL(config.artifactOrigin).host;
});

/**
 * The artifact origin: `GET /o/<key>` through a link the domain signed (`Storage.presignGet`).
 * Anything else, a forged or expired link, or a deleted object is refused.
 */
export const serveArtifact = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig;
  const links = yield* Links;
  const bucket = yield* Bucket;
  if (request.method !== "GET" && request.method !== "HEAD")
    return refused(405, "Method not allowed");
  const url = new URL(request.url, config.artifactOrigin);
  const claims = yield* links.verify(url);
  const body = yield* bucket.get(claims.key);
  if (Option.isNone(body)) return refused(404, "Deleted");
  return HttpServerResponse.stream(body.value.stream, {
    status: 200,
    headers: {
      ...securityHeaders(claims.mime, claims.name, config.appOrigin),
      "content-length": String(body.value.size),
    },
  });
}).pipe(
  Effect.catchTags({
    LinkForged: () => Effect.succeed(refused(403, "Invalid link")),
    LinkExpired: () => Effect.succeed(refused(403, "Link expired")),
    BucketUnavailable: () => Effect.succeed(refused(503, "Storage unavailable")),
  }),
);
