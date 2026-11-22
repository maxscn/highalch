import { createServer } from "node:http";
import * as InMemory from "@alchemy.run/domain/InMemory";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  CallerLive,
  GithubOidc,
  Sessions,
  type GithubClaims,
  type SessionUser,
} from "@highalch/console-domain/Authentication";
import { ConsoleApi } from "@highalch/console-domain/Console.api";
import { Console, ConsoleHandlers } from "@highalch/console-domain/Console.model";
import { makeApiKey, sessionCookie } from "@highalch/console-domain/Credentials";
import { CurrentActor } from "@highalch/console-domain/CurrentActor.context";
import { UserId } from "@highalch/console-domain/Ids";
import { ActivatePlan } from "@highalch/console-domain/Organization/ActivatePlan.command";
import { Organization } from "@highalch/console-domain/Organization/Organization.aggregate";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { ProjectId, RepositoryId } from "@highalch/console-domain/Project/Project.id";
import { AppOrigin } from "@highalch/console-domain/AppOrigin";
import { Payments } from "@highalch/console-domain/Payments.external";
import { Storage } from "@highalch/console-domain/Storage.external";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

/**
 * A local HighAlch Console for reporter tests: the real domain (`Console` with its handlers and
 * `CallerLive`) on alchemy's in-memory platform, `ConsoleApi` over HTTP on a free port, and an
 * in-memory object store whose signed PUT links check size, type and SHA-256 like R2 does.
 * It is seeded with a paid organisation, a project bound to `acme/crm`, an API key, and a
 * signed-in owner whose client reads what CI uploaded.
 */

/** One stored object. */
export interface StoredObject {
  readonly body: Uint8Array;
  readonly mime: string;
}

class Objects extends Context.Service<Objects, Map<string, StoredObject>>()("Testing/Objects") {}

class Origin extends Context.Service<Origin, { url: string }>()("Testing/Origin") {}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const base64Of = (hex: string) =>
  Result.match(Hex.decode(hex), { onSuccess: Base64.encode, onFailure: () => "" });

const StorageMemory = Storage.toLayer(
  Effect.gen(function* () {
    const objects = yield* Objects;
    const origin = yield* Origin;
    const digest = yield* Digest.Digest;
    const link = (key: string, query: Record<string, string>) =>
      `${origin.url}/objects/${encodeURIComponent(key)}?${new URLSearchParams(query).toString()}`;
    return {
      inspect: ({ key, bytes, sha256 }) =>
        Effect.gen(function* () {
          const found = objects.get(key);
          if (found === undefined) return { status: "missing" as const };
          const actual = yield* digest.digestHex(Digest.sha256, found.body);
          if (found.body.byteLength === bytes && actual === sha256)
            return { status: "ok" as const };
          objects.delete(key);
          return { status: "mismatch" as const };
        }),
      readItems: ({ key, limit }) =>
        Effect.sync(() => {
          const found = objects.get(key);
          const parsed: unknown = found === undefined ? [] : JSON.parse(decoder.decode(found.body));
          const items = Array.isArray(parsed) ? (parsed as Array<Schema.Json>) : [];
          return { items: items.slice(0, limit), total: items.length };
        }),
      writeJson: ({ key, value }) =>
        Effect.sync(() => {
          const body = encoder.encode(JSON.stringify(value));
          objects.set(key, { body, mime: "application/json" });
          return { bytes: body.byteLength };
        }),
      remove: ({ keys }) =>
        Effect.sync(() => {
          for (const key of keys) objects.delete(key);
          return {};
        }),
      presignPut: ({ key, mime, bytes, sha256, seconds }) =>
        Effect.map(Clock.currentTimeMillis, (now) => ({
          url: link(key, { expires: String(now + seconds * 1000), bytes: String(bytes) }),
          headers: {
            "content-type": mime,
            "x-amz-checksum-sha256": base64Of(sha256),
          },
        })),
      presignGet: ({ key }) => Effect.succeed({ url: link(key, {}) }),
    };
  }),
);

/** Stripe stand-in: a customer per organisation and pages on a test origin. */
const PaymentsMemory = Payments.toLayer(
  Effect.succeed({
    createCustomer: ({ org }) => Effect.succeed({ customer: `cus_${org}` }),
    checkout: ({ customer, purchase }) =>
      Effect.succeed({ url: `https://checkout.stripe.test/${customer}/${purchase.id}` }),
    portal: ({ customer }) => Effect.succeed({ url: `https://billing.stripe.test/${customer}` }),
  }),
);

/** PUT and GET of the object store's links, refused like R2 refuses a body that differs. */
const objectRoute = (key: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const objects = yield* Objects;
    const url = new URL(request.url, "http://local");
    if (request.method === "PUT") {
      const body = new Uint8Array(yield* Effect.orDie(request.arrayBuffer));
      const expires = Number(url.searchParams.get("expires"));
      if (!(expires > (yield* Clock.currentTimeMillis)))
        return HttpServerResponse.text("Request has expired", { status: 403 });
      if (body.byteLength !== Number(url.searchParams.get("bytes")))
        return HttpServerResponse.text("IncompleteBody", { status: 400 });
      const digest = yield* Digest.Digest;
      const sha256 = yield* digest.digestHex(Digest.sha256, body);
      if (base64Of(sha256) !== request.headers["x-amz-checksum-sha256"])
        return HttpServerResponse.text("BadDigest", { status: 400 });
      objects.set(key, { body, mime: request.headers["content-type"] ?? "" });
      return HttpServerResponse.empty({ status: 200 });
    }
    const found = objects.get(key);
    return found === undefined
      ? HttpServerResponse.text("NoSuchKey", { status: 404 })
      : HttpServerResponse.uint8Array(found.body, { contentType: found.mime });
  });

/** The owner the local Console is seeded with, and their session token. */
export const owner: SessionUser = {
  id: UserId.make("u-owner"),
  email: "owner@example.com",
  name: "Owner",
};
const ownerSession = "local-owner-session";

export interface Options {
  readonly org?: string;
  readonly project?: string;
  readonly plan?: string;
  /** GitHub OIDC tokens the fake verifier accepts, and their claims. */
  readonly oidc?: Readonly<Record<string, GithubClaims>>;
}

const identity = (oidc: Readonly<Record<string, GithubClaims>>) =>
  Layer.mergeAll(
    Layer.succeed(Sessions, {
      user: (token) =>
        Effect.succeed(Redacted.value(token) === ownerSession ? Option.some(owner) : Option.none()),
    }),
    Layer.succeed(GithubOidc, {
      verify: (token) => Effect.succeed(Option.fromNullishOr(oidc[Redacted.value(token)])),
    }),
  );

/**
 * Serves a local HighAlch Console until the scope closes. Answers its URL, the seeded
 * organisation, project and API key, the owner's Api client and the object store.
 */
export const serve = Effect.fn("Testing.serve")(function* (options: Options = {}) {
  const origin = { url: "" };
  const objects = new Map<string, StoredObject>();
  const services = Layer.mergeAll(
    StorageMemory,
    PaymentsMemory,
    identity(options.oidc ?? {}),
    // the app is this server: checkout and portal pages come back to it
    Layer.succeed(AppOrigin, {
      get origin() {
        return origin.url;
      },
    }),
    Digest.layerWebCrypto,
    SecureRandom.layerWebCrypto,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(Objects, objects),
        Layer.succeed(Origin, origin),
        Digest.layerWebCrypto,
      ),
    ),
  );
  const platform = InMemory.make();
  const hosted = yield* Layer.build(
    CallerLive.pipe(
      Layer.provideMerge(Console.layer(ConsoleHandlers)),
      Layer.provide(platform.layer),
      Layer.provideMerge(services),
    ),
  );

  const server = yield* NodeHttpServer.make(() => createServer(), { port: 0 });
  origin.url = HttpServer.formatAddress(server.address).replace("0.0.0.0", "127.0.0.1");
  const api = yield* ConsoleApi.pipe(Effect.provideContext(hosted));
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = new URL(request.url, "http://local").pathname;
      if (path.startsWith("/api/console")) return yield* api.fetch;
      if (path.startsWith("/objects/"))
        return yield* objectRoute(decodeURIComponent(path.slice("/objects/".length)));
      return HttpServerResponse.text("Not found", { status: 404 });
    }).pipe(Effect.provideContext(hosted)),
  );

  // seed: the owner creates the organisation, the project and a key through the Api
  const client = yield* ConsoleApi.clientInProcess.pipe(Effect.provideContext(hosted));
  const headers = { cookie: `${sessionCookie}=${ownerSession}` };
  const org = OrganizationId.make(options.org ?? "org-local");
  const project = ProjectId.make(options.project ?? "e2e");
  yield* client
    .CreateOrganization(
      org,
      { org, name: "Local", owner: owner.id, ownerEmail: owner.email, ownerName: owner.name },
      { headers },
    )
    .pipe(Effect.orDie);
  // memberships are a view: let the platform settle before the owner acts as a member
  yield* platform.control.drain;
  const organizations = Context.get(hosted, Organization);
  const now = yield* Clock.currentTimeMillis;
  yield* organizations
    .send(
      org,
      new ActivatePlan({
        plan: options.plan ?? "business",
        periodStart: now - 86_400_000,
        periodEnd: now + 30 * 86_400_000,
      }),
    )
    .pipe(Effect.provideService(CurrentActor, { _tag: "System", name: "testing" }), Effect.orDie);
  const repository = RepositoryId.make("acme/crm");
  yield* client
    .CreateProject(project, { slug: project, org, repository, defaultBranch: "main" }, { headers })
    .pipe(Effect.orDie);
  yield* client
    .ClaimRepository(repository, { repository, project, org }, { headers })
    .pipe(Effect.orDie);
  const key = yield* makeApiKey(project, "ci").pipe(Effect.provideContext(hosted));
  yield* client.IssueApiKey(project, key.input, { headers }).pipe(Effect.orDie);

  /** The owner's view of the local Console: every query and command as the signed-in owner. */
  const asOwner = <A, E>(
    call: (
      api: typeof client,
      options: { readonly headers: typeof headers },
    ) => Effect.Effect<A, E>,
  ) => call(client, { headers });

  return {
    url: origin.url,
    org,
    project,
    apiKey: Redacted.value(key.token),
    objects: objects as ReadonlyMap<string, StoredObject>,
    asOwner,
  };
});

export type LocalConsole = Effect.Success<ReturnType<typeof serve>>;
