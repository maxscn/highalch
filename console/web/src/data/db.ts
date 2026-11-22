import { ConsoleApi } from "@highalch/console-domain/Console.api";
import * as HighAlch from "@lowalch/tanstack-db";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

/**
 * The browser's connection to HighAlch Console: one `HighAlch.make` client per organisation
 * (the scope its `OrganizationChanges` feed is read for), over the Api's WebSocket client on this
 * origin's `/api/console` (calls over HTTP, live reads over WebSockets that carry the session
 * cookie). Clients are made once per organisation and kept for the page's life.
 */

declare module "@lowalch/tanstack-db" {
  interface Register {
    readonly errors: HighAlch.ApiErrors<typeof ConsoleApi>;
  }
}

/** Where the Console Api is served: the app's own origin, as the Worker serves both. */
export const apiPath = "/api/console";

const connection = (origin: string) =>
  ConsoleApi.layerClientWebSocket(`${origin}${apiPath}`).pipe(
    Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
  );

const clients = new Map<string, ReturnType<typeof make>>();

// Routes render in the browser only (`defaultSsr: false`, src/start.ts), where `window` exists.
const make = (scope: string) =>
  HighAlch.make({ api: ConsoleApi, layer: connection(window.location.origin), scope });

/**
 * The client of `scope` (an organisation id; `""` before one is chosen, which reads only
 * queries such as `me`). Browser only: the app renders without server rendering.
 */
export const clientOf = (scope: string) => {
  const known = clients.get(scope);
  if (known) return known;
  const made = make(scope);
  clients.set(scope, made);
  return made;
};

export type Client = ReturnType<typeof clientOf>;
