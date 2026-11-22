/**
 * The development backend: HighAlch Console's real Domain (`ConsoleApi` over the `Console` model
 * and its handlers) hosted on alchemy's in-memory platform inside the Vite dev server, the way
 * `Story.memory` hosts it for stories. The Api is served as the Worker will serve it: RPC over
 * HTTP and live reads (the organisation feed) over WebSocket upgrades, both on
 * `/api/console`, authenticated by the real `CallerLive` from the request's
 * `highalch_session` cookie.
 *
 * What the Worker's integrations do is faked here, and only here: an in-memory object store
 * behind `Storage` (signed links point at `/api/dev/objects/<key>`), Better Auth's sign-in
 * routes (one fixed development user), and no GitHub OIDC. Development only: nothing in `src`
 * imports this module.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import * as InMemory from "@alchemy.run/domain/InMemory";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  CallerLive,
  GithubOidc,
  Sessions,
  type SessionUser,
} from "@highalch/console-domain/Authentication";
import { ConsoleApi } from "@highalch/console-domain/Console.api";
import { Console, ConsoleHandlers } from "@highalch/console-domain/Console.model";
import { sessionCookie } from "@highalch/console-domain/Credentials";
import { AppOrigin } from "@highalch/console-domain/AppOrigin";
import { Payments } from "@highalch/console-domain/Payments.external";
import { Storage } from "@highalch/console-domain/Storage.external";
import * as Digest from "effect/crypto/Digest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { developer, sessionToken } from "./people.ts";

// ---------------------------------------------------------------- the object store

/** One stored object: its bytes and the type it is served as. */
interface StoredObject {
  readonly body: Uint8Array;
  readonly mime: string;
}

/** The development object store (R2 in production), shared by `Storage` and the dev routes. */
export class Objects extends Context.Service<Objects, Map<string, StoredObject>>()("Dev/Objects") {}

const sha256Of = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Where a signed link of the development store points: this dev server, by key. */
export const objectPath = (key: string) => `/api/dev/objects/${encodeURIComponent(key)}`;

/**
 * How signed GET links point at the store: `path`, this dev server's `/api/dev/objects/<key>`;
 * `data`, the object itself as a `data:` URL (stories, which run without a server).
 */
export type Links = "path" | "data";

const dataUrl = (found: StoredObject) =>
  `data:${found.mime};base64,${Buffer.from(found.body).toString("base64")}`;

const storageDev = (links: Links) =>
  Storage.toLayer(
    Effect.gen(function* () {
      const objects = yield* Objects;
      return {
        inspect: ({ key, bytes, sha256 }) =>
          Effect.sync(() => {
            const found = objects.get(key);
            if (found === undefined) return { status: "missing" as const };
            if (found.body.byteLength === bytes && sha256Of(found.body) === sha256)
              return { status: "ok" as const };
            objects.delete(key);
            return { status: "mismatch" as const };
          }),
        readItems: ({ key, limit }) =>
          Effect.sync(() => {
            const found = objects.get(key);
            if (found === undefined) return { items: [], total: 0 };
            const parsed: unknown = JSON.parse(decoder.decode(found.body));
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
        presignPut: ({ key, mime }) =>
          Effect.succeed({ url: objectPath(key), headers: { "content-type": mime } }),
        presignGet: ({ key }) =>
          Effect.sync(() => {
            const found = objects.get(key);
            return {
              url: links === "data" && found !== undefined ? dataUrl(found) : objectPath(key),
            };
          }),
      };
    }),
  );

// ---------------------------------------------------------------- identity

/** Better Auth stand-in: the one development session and its user. */
const SessionsDev = Layer.succeed(Sessions, {
  user: (token: Redacted.Redacted<string>) =>
    Effect.succeed(
      Redacted.value(token) === sessionToken ? Option.some<SessionUser>(developer) : Option.none(),
    ),
});

/** No Stripe in development: checkout and the portal come back to the settings page. */
const PaymentsDev = Payments.toLayer(
  Effect.succeed({
    createCustomer: ({ org }) => Effect.succeed({ customer: `cus_dev_${org}` }),
    checkout: ({ successUrl }) => Effect.succeed({ url: successUrl }),
    portal: ({ returnUrl }) => Effect.succeed({ url: returnUrl }),
  }),
);

/** No GitHub Actions in development: every OIDC token is refused. */
const GithubOidcDev = Layer.succeed(GithubOidc, { verify: () => Effect.succeed(Option.none()) });

// ---------------------------------------------------------------- routes

const cookie = (value: string, maxAge: number) =>
  `${sessionCookie}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

const SignInEmail = Schema.Struct({ email: Schema.String, password: Schema.String });
const SignInSocial = Schema.Struct({
  provider: Schema.String,
  callbackURL: Schema.optional(Schema.String),
});

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

const signedIn = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeader(response, "set-cookie", cookie(sessionToken, 60 * 60 * 24 * 30));

const userBody = {
  id: developer.id,
  email: developer.email,
  name: developer.name,
  emailVerified: true,
  image: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
};

/**
 * Better Auth's routes the app calls, answering as Better Auth does for the one development user
 * (`dev/people.ts`): email and password, GitHub (signs in at once), session, sign-out.
 */
const auth = (path: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    switch (path) {
      case "/api/auth/sign-in/email": {
        const body = yield* Effect.flatMap(request.json, Schema.decodeUnknownEffect(SignInEmail));
        if (body.email.toLowerCase() !== developer.email || body.password !== developer.password)
          return json(
            { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
            401,
          );
        return signedIn(json({ redirect: false, token: sessionToken, user: userBody }));
      }
      case "/api/auth/sign-in/social": {
        const body = yield* Effect.flatMap(request.json, Schema.decodeUnknownEffect(SignInSocial));
        const back = body.callbackURL ?? "/";
        return json({
          redirect: true,
          url: `/api/auth/callback/dev?callbackURL=${encodeURIComponent(back)}`,
        });
      }
      case "/api/auth/callback/dev": {
        const back = new URL(request.url, "http://dev").searchParams.get("callbackURL") ?? "/";
        // only same-origin paths
        return signedIn(HttpServerResponse.redirect(back.startsWith("/") ? back : "/"));
      }
      case "/api/auth/get-session":
        return request.cookies[sessionCookie] === sessionToken
          ? json({ session: { token: sessionToken, userId: developer.id }, user: userBody })
          : json(null);
      case "/api/auth/sign-out":
        return HttpServerResponse.setHeader(json({ success: true }), "set-cookie", cookie("", 0));
      default:
        return json({ code: "NOT_FOUND", message: `No route ${path}` }, 404);
    }
  });

/** The development object store over HTTP: what signed GET and PUT links reach. */
const objectRoute = (key: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const objects = yield* Objects;
    if (request.method === "PUT") {
      const body = new Uint8Array(yield* request.arrayBuffer);
      objects.set(key, {
        body,
        mime: request.headers["content-type"] ?? "application/octet-stream",
      });
      return HttpServerResponse.empty({ status: 200 });
    }
    const found = objects.get(key);
    if (found === undefined) return HttpServerResponse.text("Not found", { status: 404 });
    return HttpServerResponse.uint8Array(found.body, {
      contentType: found.mime,
      headers: { "cache-control": "private, max-age=3600" },
    });
  });

// ---------------------------------------------------------------- the host

/** Every request the dev server hands the backend: `/api/console`, `/api/auth`, `/api/dev`. */
export const handles = (url: string) => /^\/api\/(console|auth|dev)(\/|\?|$)/.test(url);

export interface DevBackend {
  /** Serves an HTTP request (Vite's connect middleware). */
  readonly request: (request: IncomingMessage, response: ServerResponse) => void;
  /** Serves a WebSocket upgrade of `/api/console` (a live read). */
  readonly upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  readonly dispose: () => Promise<void>;
}

/** The hosted Console: the model on the in-memory platform, its services and `CallerLive`. */
export const host = (links: Links = "path", origin = "http://localhost:5201") => {
  // Seeded history is stamped with its own times; afterwards the platform runs on `Date.now`.
  const clock: SeedClock = { at: undefined };
  const platform = InMemory.make({ now: () => clock.at ?? Date.now() });

  const services = Layer.mergeAll(
    storageDev(links).pipe(Layer.provideMerge(Layer.sync(Objects, () => new Map()))),
    SessionsDev,
    GithubOidcDev,
    PaymentsDev,
    Layer.succeed(AppOrigin, { origin }),
    Digest.layerWebCrypto,
  );

  const model = Console.layer(ConsoleHandlers).pipe(
    Layer.provide(platform.layer),
    Layer.provideMerge(services),
  );

  return { clock, platform, layer: CallerLive.pipe(Layer.provideMerge(model)) };
};

/** The platform clock while seeding: `at` stamps what is sent now; `undefined` is `Date.now`. */
export type SeedClock = { at: number | undefined };

/** What the hosted runtime holds: the model's aggregates, views and stores, its services. */
export type Hosted = Layer.Success<ReturnType<typeof host>["layer"]>;

/**
 * Hosts the Console in memory, seeds it (`seed`, an Effect over the hosted model that sets the
 * platform clock to the history's own times), waits until the platform is idle, and serves it.
 */
export const start = async <E>(
  seed: (clock: SeedClock, idle: Effect.Effect<void>) => Effect.Effect<void, E, Hosted>,
  origin: string,
): Promise<DevBackend> => {
  const { clock, platform, layer } = host("path", origin);
  const runtime = ManagedRuntime.make(layer);

  await runtime.runPromise(seed(clock, platform.control.idle));
  clock.at = undefined;
  await Effect.runPromise(platform.control.idle);

  const scope = await Effect.runPromise(Scope.make());

  const handlers = await runtime.runPromise(
    Effect.gen(function* () {
      const api = yield* ConsoleApi;
      const app = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.url, "http://dev").pathname;
        if (path.startsWith("/api/console")) return yield* api.fetch;
        if (path.startsWith("/api/auth/")) return yield* auth(path);
        if (path.startsWith("/api/dev/objects/"))
          return yield* objectRoute(decodeURIComponent(path.slice("/api/dev/objects/".length)));
        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      );
      const wss = Effect.succeed(new NodeWS.WebSocketServer({ noServer: true }));
      const request = yield* NodeHttpServer.makeHandler(app, { scope });
      const upgrade = yield* NodeHttpServer.makeUpgradeHandler(wss, app, { scope });
      return { request, upgrade };
    }),
  );

  return {
    request: (request, response) => handlers.request(request, response),
    upgrade: (request, socket, head) => handlers.upgrade(request, socket, head),
    dispose: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    },
  };
};
