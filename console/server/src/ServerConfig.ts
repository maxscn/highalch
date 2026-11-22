import { AppOrigin } from "@highalch/console-domain/AppOrigin";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

/** What the Worker is told at deploy (and `alchemy dev`) time. */
export interface ServerConfigShape {
  /** Origin of the web app and the Api (`https://console.highalch.dev`). */
  readonly appOrigin: string;
  /**
   * Origin that serves stored bodies through signed links. Never the app's origin (ideally
   * another registrable domain): uploaded content is hostile.
   */
  readonly artifactOrigin: string;
  /** HMAC key (at least 32 bytes) signing GET links on the artifact origin. */
  readonly linkSecret: Redacted.Redacted<string>;
  /** `stripe` (deployed) or `local` (`alchemy dev`: no Stripe account is touched). */
  readonly payments: "stripe" | "local";
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "Console/ServerConfig",
) {}

/** From `HIGHALCH_APP_ORIGIN`, `HIGHALCH_ARTIFACT_ORIGIN`, `HIGHALCH_LINK_SECRET`, `HIGHALCH_PAYMENTS`. */
export const config = Config.all({
  appOrigin: Config.String("HIGHALCH_APP_ORIGIN"),
  artifactOrigin: Config.String("HIGHALCH_ARTIFACT_ORIGIN"),
  linkSecret: Config.Redacted("HIGHALCH_LINK_SECRET"),
  payments: Config.Literals(["stripe", "local"], "HIGHALCH_PAYMENTS"),
});

/** The domain's `AppOrigin`: where checkout and portal pages may send the browser back to. */
export const appOrigin = Layer.effect(
  AppOrigin,
  Effect.map(Effect.service(ServerConfig), (config) => AppOrigin.of({ origin: config.appOrigin })),
);

export const layer = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    return ServerConfig.of(yield* config);
  }),
);
