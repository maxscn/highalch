import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Where the web app is served (`https://console.example`): the server provides it. */
export class AppOrigin extends Context.Service<AppOrigin, { readonly origin: string }>()(
  "Console/AppOrigin",
) {}

/** A page the payment provider would send the browser back to is not on the app's origin. */
export class ReturnUrlRefused extends Domain.Rejection(
  "ReturnUrlRefused",
  { url: Schema.String },
  { httpApiStatus: 422 },
) {}

/** Succeeds when every URL is on the app's origin, else names the first that is not. */
export const onAppOrigin = (origin: string, ...urls: ReadonlyArray<string>) => {
  const foreign = urls.find((url) => !URL.canParse(url) || new URL(url).origin !== origin);
  return foreign === undefined ? Effect.void : Effect.fail(new ReturnUrlRefused({ url: foreign }));
};
