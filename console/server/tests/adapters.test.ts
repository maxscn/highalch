import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { presignR2Url } from "@alchemy.run/cloudflare/R2/PresignToken";
import { GithubOidc } from "@highalch/console-domain/Authentication";
import { formatApiKey, sessionCookie } from "@highalch/console-domain/Credentials";
import { Storage } from "@highalch/console-domain/Storage.external";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Jwks from "effect/jose/Jwks";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";
import { securityHeaders } from "../src/ArtifactOrigin.ts";
import { Bucket, BucketUnavailable } from "../src/Bucket.ts";
import * as GithubOidcLive from "../src/GithubOidc.ts";
import * as Links from "../src/Links.ts";
import { budgetOf } from "../src/RateLimit.ts";
import { ServerConfig } from "../src/ServerConfig.ts";
import { StorageLive } from "../src/Storage.ts";

const config = Layer.succeed(ServerConfig, {
  appOrigin: "https://console.example",
  artifactOrigin: "https://artifacts.example",
  linkSecret: Redacted.make("test-link-secret-0123456789abcdef0123"),
  payments: "local",
});

const crypto = Layer.mergeAll(
  Digest.layerWebCrypto,
  Mac.layerWebCrypto,
  Signature.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

/** An in-memory bucket whose PUT links are R2's (SigV4 over every given header). */
const memoryBucket = (objects: Map<string, Uint8Array>) =>
  Layer.succeed(
    Bucket,
    Bucket.of({
      head: (key) =>
        Effect.succeed(
          Option.map(Option.fromNullishOr(objects.get(key)), (body) => ({
            size: body.byteLength,
            sha256: Option.some(createHash("sha256").update(body).digest("hex")),
          })),
        ),
      get: (key) =>
        Effect.succeed(
          Option.map(Option.fromNullishOr(objects.get(key)), (body) => ({
            size: body.byteLength,
            stream: Stream.make(body),
            bytes: Effect.succeed(body),
          })),
        ),
      put: (key, body) => Effect.sync(() => void objects.set(key, body)),
      remove: (keys) => Effect.sync(() => keys.forEach((key) => objects.delete(key))),
      presignPut: ({ key, headers, seconds }) =>
        presignR2Url(
          {
            endpoint: "https://account.r2.cloudflarestorage.com",
            bucketName: "artifacts",
            region: "auto",
            accessKeyId: "AKIDEXAMPLE",
            secretAccessKey: "secret",
          },
          { method: "PUT", key, expiresIn: seconds, headers: { ...headers } },
        ).pipe(
          Effect.mapError(
            (error) => new BucketUnavailable({ operation: "presign", message: String(error) }),
          ),
        ),
    }),
  );

const storage = (objects: Map<string, Uint8Array>) =>
  StorageLive.pipe(
    Layer.provide(Links.layer),
    Layer.provideMerge(Layer.mergeAll(memoryBucket(objects), config, crypto)),
  );

const withStorage = <A, E>(
  objects: Map<string, Uint8Array>,
  use: (storage: (typeof Storage)["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(Storage), use).pipe(Effect.provide(storage(objects))),
  );

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("Storage over R2", () => {
  it("signs PUT links over the exact type, length and SHA-256", async () => {
    const link = await withStorage(new Map(), (s) =>
      s.presignPut({
        key: "a/org/abc/0",
        mime: "image/png",
        bytes: 3,
        sha256: sha("abc"),
        seconds: 60,
      }),
    );
    expect(link.headers).toEqual({
      "content-type": "image/png",
      "content-length": "3",
      "x-amz-checksum-sha256": createHash("sha256").update("abc").digest("base64"),
    });
    const url = new URL(link.url);
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
      expect.arrayContaining(["content-length", "content-type", "host", "x-amz-checksum-sha256"]),
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
  });

  it("signs GET links for the artifact origin only", async () => {
    const { url } = await withStorage(new Map(), (s) =>
      s.presignGet({ key: "a/org/abc/0", mime: "text/html", name: "x.html", seconds: 60 }),
    );
    expect(url.startsWith("https://artifacts.example/o/a/org/abc/0?")).toBe(true);
  });

  it("deletes a body that is not what was declared, and keeps one that is", async () => {
    const objects = new Map([
      ["ok", new TextEncoder().encode("abc")],
      ["bad", new TextEncoder().encode("abd")],
    ]);
    const [ok, bad, missing] = await withStorage(objects, (s) =>
      Effect.all([
        s.inspect({ key: "ok", bytes: 3, sha256: sha("abc") }),
        s.inspect({ key: "bad", bytes: 3, sha256: sha("abc") }),
        s.inspect({ key: "none", bytes: 3, sha256: sha("abc") }),
      ]),
    );
    expect([ok?.status, bad?.status, missing?.status]).toEqual(["ok", "mismatch", "missing"]);
    expect([...objects.keys()]).toEqual(["ok"]);
  });

  it("reads at most `limit` items and counts them all", async () => {
    const objects = new Map([["r", new TextEncoder().encode(JSON.stringify([1, 2, 3, 4]))]]);
    const read = await withStorage(objects, (s) => s.readItems({ key: "r", limit: 2 }));
    expect(read).toEqual({ items: [1, 2], total: 4 });
  });
});

describe("signed GET links", () => {
  const links = <A, E>(use: (links: (typeof Links.Links)["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(Links.Links), use).pipe(
        Effect.provide(Links.layer.pipe(Layer.provide(Layer.mergeAll(config, crypto)))),
      ),
    );

  it("verifies its own links and refuses a changed type, key or expiry", async () => {
    const url = await links((l) =>
      l.sign({ key: "a/o/s/0", mime: "image/png", name: "a.png", seconds: 60 }),
    );
    expect(await links((l) => l.verify(new URL(url)))).toMatchObject({
      key: "a/o/s/0",
      mime: "image/png",
    });
    for (const [param, value] of [
      ["m", "text/html"],
      ["e", String(Date.now() + 3_600_000)],
      ["n", "b.html"],
    ] as const) {
      const forged = new URL(url);
      forged.searchParams.set(param, value);
      expect(await links((l) => Effect.flip(l.verify(forged)))).toMatchObject({
        _tag: "LinkForged",
      });
    }
    const otherKey = new URL(url.replace("/o/a/o/s/0", "/o/a/o/s/1"));
    expect(await links((l) => Effect.flip(l.verify(otherKey)))).toMatchObject({
      _tag: "LinkForged",
    });
  });

  it("refuses an expired link", async () => {
    const url = await links((l) =>
      l.sign({ key: "k", mime: "image/png", name: null, seconds: -1 }),
    );
    expect(await links((l) => Effect.flip(l.verify(new URL(url))))).toMatchObject({
      _tag: "LinkExpired",
    });
  });
});

describe("the artifact origin's headers", () => {
  it("serves passive media inline and anything active as an attachment, always sandboxed", () => {
    const png = securityHeaders("image/png", "a.png", "https://app");
    expect(png).toMatchObject({
      "content-type": "image/png",
      "content-disposition": 'inline; filename="a.png"',
    });
    for (const active of [
      "text/html",
      "image/svg+xml",
      "application/javascript",
      "application/xhtml+xml",
      "application/pdf",
    ]) {
      const headers = securityHeaders(active, "x", "https://app");
      expect(headers["content-type"]).toBe("application/octet-stream");
      expect(headers["content-disposition"]?.startsWith("attachment")).toBe(true);
    }
    expect(png["content-security-policy"]).toContain("sandbox");
    expect(png["x-content-type-options"]).toBe("nosniff");
    expect(png["access-control-allow-origin"]).toBe("https://app");
  });
});

// ---------------------------------------------------------------- GitHub OIDC

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

const token = (claims: Record<string, unknown>, kid = "k1") => {
  const input = `${b64({ alg: "RS256", typ: "JWT", kid })}.${b64(claims)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
};

const now = () => Math.floor(Date.now() / 1000);
const valid = () => ({
  iss: GithubOidcLive.issuer,
  aud: "highalch",
  exp: now() + 300,
  iat: now(),
  repository: "acme/crm",
  sha: "c0ffee0",
  ref: "refs/heads/main",
});

const verify = (jwt: string) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(GithubOidc), (oidc) => oidc.verify(Redacted.make(jwt))).pipe(
      Effect.provide(
        GithubOidcLive.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Jwks.layerLocal({ keys: [jwk] } as never),
              Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)),
            ),
          ),
        ),
      ),
    ),
  );

describe("GitHub OIDC verification", () => {
  it("accepts a token GitHub signed for audience highalch", async () => {
    expect(Option.getOrUndefined(await verify(token(valid())))).toMatchObject({
      repository: "acme/crm",
      sha: "c0ffee0",
    });
  });

  it("refuses a wrong audience, a wrong issuer, an expired token, an unknown key, a bad signature", async () => {
    const refused = [
      token({ ...valid(), aud: "assay" }),
      token({ ...valid(), iss: "https://example.com" }),
      token({ ...valid(), exp: now() - 120 }),
      token(valid(), "k2"),
      `${token(valid()).slice(0, -4)}AAAA`,
    ];
    for (const jwt of refused) expect(Option.isNone(await verify(jwt))).toBe(true);
  });
});

// ---------------------------------------------------------------- rate limits

describe("request budgets", () => {
  const budget = (headers: Record<string, string>) =>
    Effect.runPromise(
      budgetOf(Headers.fromInput(headers)).pipe(
        Effect.provide(
          Layer.mergeAll(
            Digest.layerWebCrypto,
            Layer.succeed(GithubOidc, {
              verify: (t) =>
                Effect.succeed(
                  Redacted.value(t) === "gh-ok"
                    ? Option.some({ repository: "Acme/CRM", sha: "x", ref: "refs/heads/main" })
                    : Option.none(),
                ),
            }),
          ),
        ),
      ),
    );

  it("spends per API key, per verified repository, per session, else per address", async () => {
    const key = formatApiKey("crm", "k1", "secret");
    expect(await budget({ authorization: `Bearer ${key}` })).toMatchObject({
      budget: "ci",
      key: expect.stringMatching(/^key:crm\.k1:[0-9a-f]{32}$/),
    });
    expect(await budget({ authorization: "Bearer gh-ok" })).toEqual({
      budget: "ci",
      key: "repo:acme/crm",
    });
    expect(
      await budget({ authorization: "Bearer gh-forged", "cf-connecting-ip": "1.2.3.4" }),
    ).toEqual({
      budget: "address",
      key: "ip:1.2.3.4",
    });
    expect(await budget({ cookie: `${sessionCookie}=abc` })).toMatchObject({ budget: "session" });
    expect(await budget({ "cf-connecting-ip": "5.6.7.8" })).toEqual({
      budget: "address",
      key: "ip:5.6.7.8",
    });
  });

  it("does not let a forged token spend a real key's budget", async () => {
    const real = await budget({ authorization: `Bearer ${formatApiKey("crm", "k1", "secret")}` });
    const forged = await budget({ authorization: `Bearer ${formatApiKey("crm", "k1", "guess")}` });
    expect(forged.key).not.toBe(real.key);
  });
});
