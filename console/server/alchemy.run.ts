import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Stripe from "@alchemy.run/stripe";
import { Stack, Stage } from "alchemy";
import { localState } from "alchemy/State";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ConsoleWorker from "./src/Worker.ts";

/** The stage `alchemy dev --stage local` runs: everything on this machine, no account touched. */
export const localStage = "local";

/**
 * What the Worker is configured with on the local stage. Two origins on one port: the app and
 * the Api on `localhost`, the artifact origin on `127.0.0.1`. The Stripe webhook secret is a
 * local one, so tests and developers can deliver signed events.
 */
export const localConfig = {
  HIGHALCH_APP_ORIGIN: "http://localhost:4810",
  HIGHALCH_ARTIFACT_ORIGIN: "http://127.0.0.1:4810",
  HIGHALCH_LINK_SECRET: "local-only-link-secret-0123456789abcdef",
  HIGHALCH_PAYMENTS: "local",
  STRIPE_WEBHOOK_SECRET__api_billing_stripe_webhook: "whsec_local_highalch_console",
};

/**
 * HighAlch Console: one Worker hosting the Console model on Durable Objects, with its R2 bucket,
 * Better Auth's D1 database and rate limits. Deployed stages read `HIGHALCH_APP_ORIGIN`,
 * `HIGHALCH_ARTIFACT_ORIGIN`, `HIGHALCH_LINK_SECRET`, `HIGHALCH_PAYMENTS=stripe` and optionally
 * `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` from the environment, and need Cloudflare and
 * Stripe credentials; the local stage needs neither.
 */
export default Stack(
  "highalch-console",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      DomainCloudflare.providers(),
      Stripe.providers(),
    ),
    // OWNER: a deployed stage needs a shared state store (e.g. `Cloudflare.state()`)
    state: localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const worker = yield* stage === localStage
      ? ConsoleWorker.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(localConfig))),
        )
      : ConsoleWorker;
    return { url: worker.url };
  }),
);
