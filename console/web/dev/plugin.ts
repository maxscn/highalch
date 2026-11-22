import { join } from "node:path";
import type { Plugin, ViteDevServer } from "vite-plus";
import type { DevBackend } from "./backend.ts";

/**
 * Serves the development backend (`./backend.ts`: the Console Domain hosted in memory) on the dev
 * server's own origin, as the Worker serves the Api and the app together: `/api/console` (RPC
 * and live-read WebSocket upgrades), `/api/auth` and `/api/dev`. `vp dev` only: never part of a
 * build. The backend loads through Vite's SSR module graph so it can import the workspace's
 * TypeScript sources and HighAlch from source.
 */
export const consoleDevBackend = (seedRoot: string): Plugin => ({
  name: "highalch-console-dev-backend",
  apply: (_, env) => env.command === "serve" && process.env["VITEST"] === undefined,
  configureServer(server: ViteDevServer) {
    let backend: Promise<DevBackend> | undefined;
    const load = () =>
      (backend ??= Promise.all([
        server.ssrLoadModule(join(import.meta.dirname, "backend.ts")),
        server.ssrLoadModule(join(import.meta.dirname, "seed.ts")),
      ]).then(([hosting, seeding]) => {
        const { start } = hosting as typeof import("./backend.ts");
        const { seed } = seeding as typeof import("./seed.ts");
        const started = Date.now();
        const origin = `http://localhost:${server.config.server.port}`;
        return start(seed(seedRoot), origin).then((ready) => {
          server.config.logger.info(
            `  console dev backend: seeded in ${((Date.now() - started) / 1000).toFixed(1)} s`,
          );
          return ready;
        });
      }));

    // Start (and seed) right away, so the first page load does not wait for it.
    void load().catch((error: unknown) => server.config.logger.error(String(error)));

    server.middlewares.use((request, response, next) => {
      if (!/^\/api\/(console|auth|dev)(\/|\?|$)/.test(request.url ?? "")) return next();
      load().then(
        (ready) => ready.request(request, response),
        (error: unknown) => {
          response.statusCode = 503;
          response.end(`The development backend failed to start: ${String(error)}`);
        },
      );
    });

    server.httpServer?.on("upgrade", (request, socket, head) => {
      if (!(request.url ?? "").startsWith("/api/console")) return;
      load().then(
        (ready) => ready.upgrade(request, socket, head),
        () => socket.destroy(),
      );
    });

    server.httpServer?.on("close", () => {
      void backend?.then((ready) => ready.dispose());
    });
  },
});
