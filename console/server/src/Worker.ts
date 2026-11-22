import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Stripe from "@alchemy.run/stripe";
import {
  CallerLive,
  type GithubOidc as DomainGithubOidc,
} from "@highalch/console-domain/Authentication";
import { ConsoleApi } from "@highalch/console-domain/Console.api";
import { Console, ConsoleHandlers } from "@highalch/console-domain/Console.model";
import { sessionCookie } from "@highalch/console-domain/Credentials";
import * as Config from "effect/Config";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ambient } from "./Ambient.ts";
import { isArtifactHost, serveArtifact } from "./ArtifactOrigin.ts";
import * as Bindings from "./Cloudflare.ts";
import * as GithubOidc from "./GithubOidc.ts";
import * as Links from "./Links.ts";
import {
  ChargeDisputeClosed,
  ChargeDisputeCreated,
  ChargeRefunded,
  CheckoutAsyncPaymentSucceeded,
  onPaymentEvent,
} from "./PaymentEvents.ts";
import { linkCustomer } from "./LocalAdmin.ts";
import * as Payments from "./Payments.ts";
import { limited, type RateLimit } from "./RateLimit.ts";
import type { Bucket } from "./Bucket.ts";
import * as ServerConfig from "./ServerConfig.ts";
import * as Sessions from "./Sessions.ts";
import { StorageLive } from "./Storage.ts";

/** Where the Worker serves what. */
export const paths = {
  /** `ConsoleApi`: RPC over HTTP (CI, browsers) and live reads over WebSocket upgrades. */
  api: "/api/console",
  /** Better Auth's routes. */
  auth: "/api/auth",
  /** Stripe's verified deliveries. */
  stripeWebhook: "/api/billing/stripe-webhook",
  /** Local stage only: link a payment customer to an organisation that has none. */
  localLinkCustomer: "/api/local/link-customer",
} as const;

/** Better Auth for browsers, its session token in the `highalch_session` cookie. */
const AuthLive = Layer.effect(
  Sessions.Auth,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const secure = config.appOrigin.startsWith("https://");
    const github = yield* Config.all({
      clientId: Config.Redacted("GITHUB_CLIENT_ID"),
      clientSecret: Config.Redacted("GITHUB_CLIENT_SECRET"),
    }).pipe(Config.option);
    const auth = yield* BetterAuth({
      basePath: paths.auth,
      baseURL: config.appOrigin,
      trustedOrigins: [config.appOrigin],
      emailAndPassword: { enabled: true },
      ...(github._tag === "Some"
        ? {
            socialProviders: {
              github: {
                clientId: Redacted.value(github.value.clientId),
                clientSecret: Redacted.value(github.value.clientSecret),
              },
            },
          }
        : {}),
      advanced: {
        // the domain reads the cookie by this exact name, so Better Auth's `__Secure-` prefix is
        // off and `secure` is set on the attribute instead
        useSecureCookies: false,
        cookies: {
          session_token: {
            name: sessionCookie,
            attributes: { secure, sameSite: "lax", httpOnly: true, path: "/" },
          },
        },
      },
    });
    return Sessions.Auth.of({
      fetch: ambient(auth.fetch),
      getSession: (headers: Headers) => ambient(auth.getSession(headers)),
    });
  }),
);

/** The hosted model on Durable Objects, `CallerLive` and every adapter they need. */
const ConsoleLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const payments = config.payments === "stripe" ? Payments.stripe : Payments.local;
    const crypto = Layer.mergeAll(Digest.layerWebCrypto, Mac.layerWebCrypto).pipe(
      Layer.provideMerge(SecureRandom.layerWebCrypto),
    );
    const adapters = Layer.mergeAll(
      StorageLive.pipe(Layer.provide(Links.layer)),
      payments,
      Sessions.layer,
      GithubOidc.live,
      Links.layer,
      ServerConfig.appOrigin,
      Bindings.bucket,
      Bindings.rateLimit,
    ).pipe(Layer.provideMerge(Layer.mergeAll(crypto, Bindings.bucket)));
    return CallerLive.pipe(
      Layer.provideMerge(Console.layer(ConsoleHandlers)),
      Layer.provide(DomainCloudflare.layerDurableObjects()),
      Layer.provideMerge(adapters),
    );
  }),
).pipe(Layer.provideMerge(AuthLive), Layer.provideMerge(ServerConfig.layer));

/**
 * The HighAlch Console Worker. It hosts the Console model on Durable Objects and adapts:
 * `ConsoleApi` for browsers and CI (rate limited per credential), Better Auth, Stripe's webhook
 * into `ConsoleSystemApi`, and the artifact origin serving signed GET links. It has no behaviour
 * of its own.
 */
export default class ConsoleWorker extends Cloudflare.Worker<ConsoleWorker>()(
  "ConsoleWorker",
  {
    main: import.meta.url,
    compatibility: { flags: ["nodejs_compat"], date: "2026-11-01" },
    // the cost model's CPU cap per request
    limits: { cpuMs: 50 },
    dev: { port: 4810, strictPort: true },
  },
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const api = yield* ConsoleApi;
    const auth = yield* Sessions.Auth;
    // what the local admin route uses: the hosted model and the payments adapter
    const admin =
      yield* Effect.context<
        Exclude<Effect.Services<typeof linkCustomer>, HttpServerRequest.HttpServerRequest>
      >();
    // what the routes use besides the request, resolved once
    const services = yield* Effect.context<
      | Bucket
      | Links.Links
      | ServerConfig.ServerConfig
      | RateLimit
      | Digest.Digest
      | DomainGithubOidc
    >();

    // under `alchemy dev` no endpoint is provisioned: bind a local signing secret to test with
    if (config.payments === "local")
      yield* Config.Redacted("STRIPE_WEBHOOK_SECRET__api_billing_stripe_webhook");
    // verified deliveries only (alchemy checks the signature)
    yield* Stripe.consumeEvents(
      {
        path: paths.stripeWebhook,
        events: [
          Stripe.InvoicePaid,
          Stripe.InvoicePaymentFailed,
          Stripe.CheckoutSessionCompleted,
          CheckoutAsyncPaymentSucceeded,
          ChargeRefunded,
          ChargeDisputeCreated,
          ChargeDisputeClosed,
        ] as never,
      },
      (event: { readonly type: string; readonly object: unknown }) => onPaymentEvent(event),
    );

    return {
      fetch: Effect.gen(function* () {
        if (yield* isArtifactHost) return yield* serveArtifact;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.url, config.appOrigin).pathname;
        if (path === paths.api || path.startsWith(`${paths.api}/`))
          return yield* limited(api.fetch);
        if (path.startsWith(`${paths.auth}/`)) return yield* limited(auth.fetch);
        if (config.payments === "local" && path === paths.localLinkCustomer)
          return yield* linkCustomer.pipe(Effect.provideContext(admin));
        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(Effect.provideContext(services)),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ConsoleLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Cloudflare.R2.ReadWriteBucketBinding,
              Cloudflare.Workers.RateLimitBinding,
              Stripe.CreateCustomerHttp,
              Stripe.CreateCheckoutSessionHttp,
              Stripe.CreateBillingPortalSessionHttp,
              CloudflareD1(Bindings.AuthDb),
            ),
          ),
        ),
        Stripe.ConsumeEventsLive,
      ),
    ),
  ),
) {}
