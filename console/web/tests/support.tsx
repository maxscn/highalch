import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Caller } from "@highalch/console-domain/Caller.middleware";
import { ConsoleApi } from "@highalch/console-domain/Console.api";
import { sessionCookie } from "@highalch/console-domain/Credentials";
import * as Story from "@highalch/story";
import { Screen } from "@highalch/story/screen";
import { Takumi } from "@highalch/story/takumi";
import { LowAlchDb } from "@highalch/story/lowalch";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { act, useState } from "react";
import { host, type Hosted } from "../dev/backend.ts";
import { sessionToken } from "../dev/people.ts";
import { seed } from "../dev/seed.ts";
import { downloads } from "../src/data/items.ts";
import { NowProvider } from "../src/lib/now.tsx";
import { createConsoleRouter } from "../src/router.tsx";
import css from "../src/styles.css?inline";

/**
 * Screen stories of HighAlch Console: the real Domain hosted in memory with the development seed
 * (`dev/seed.ts`, on a clock fixed at the seed's times), the real app's routes mounted at a URL
 * under the story's client, and frames painted by takumi at 1440 × 1000 in light and dark.
 */

/** "Now" in every story: the seeded history is relative to it, so frames never age. */
export const NOW = Date.parse("2026-11-19T13:30:00.000Z");

const seedRoot = join(import.meta.dirname, "../.seed");

/**
 * The Console as a story host: `dev/backend.ts`'s host with signed links as `data:` URLs (no
 * server), seeded once per story, then the platform clock stays at `NOW`. Every scope reads as
 * the development user (their session cookie on every call), as a signed-in browser does.
 */
const hosting: Story.Hosting<typeof ConsoleApi> = async () => {
  const { clock, platform, layer } = host("data");
  const runtime = ManagedRuntime.make(layer);
  await runtime.runPromise(seed(seedRoot)(clock, platform.control.idle));
  await Effect.runPromise(platform.control.idle);
  clock.at = NOW;
  const context = await runtime.runPromise(Effect.context<Hosted>());
  const live = Context.get(context, Caller);
  const headers = Headers.fromInput({ cookie: `${sessionCookie}=${sessionToken}` });
  const signedIn = Context.add(context, Caller, (effect, options) =>
    live(effect, { ...options, headers }),
  );
  const clients: Array<ManagedRuntime.ManagedRuntime<unknown, never>> = [];
  const shared = new Map<string, Promise<typeof ConsoleApi.Client.Service>>();
  return {
    api: ConsoleApi,
    // LowAlch clients for the Db steps and the mounted screens, over this host's clients.
    adapters: [LowAlchDb.connect()],
    client: (scope) => {
      const known = shared.get(scope);
      if (known) return known;
      const client = ManagedRuntime.make(
        ConsoleApi.layerClientInProcess.pipe(Layer.provide(Layer.succeedContext(signedIn))),
      );
      clients.push(client as ManagedRuntime.ManagedRuntime<unknown, never>);
      const made = client.runPromise(Effect.service(ConsoleApi.Client));
      shared.set(scope, made);
      return made;
    },
    idle: () => Effect.runPromise(Effect.as(platform.control.idle, true)),
    service: (key) => runtime.runPromise(Effect.service(key as Context.Key<never, never>)),
    dispose: async () => {
      for (const client of clients) await client.dispose();
      await runtime.dispose();
    },
  };
};

/** A story over the seeded Console, as a member of Acme. */
export const consoleStory = Story.make(hosting, { scope: "acme" });

const require = createRequire(import.meta.url);
const font = (pkg: string, file: string, name: string) => ({
  name,
  data: readFileSync(join(require.resolve(`${pkg}/package.json`), "..", "files", file)),
});

const fonts = [
  font("@fontsource-variable/geist", "geist-latin-wght-normal.woff2", "Geist Variable"),
  font(
    "@fontsource-variable/geist-mono",
    "geist-mono-latin-wght-normal.woff2",
    "Geist Mono Variable",
  ),
];

/** A phone: 390 × 844, the narrow layout (sidebar as a row above the content). */
export const phone = Screen.make({ css, width: 390, height: 844 }).pipe(
  Takumi.frames({
    fonts,
    baselines: join(import.meta.dirname, "baselines"),
    output: join(import.meta.dirname, "../artifacts/stories"),
    update: process.env["UPDATE_SCREENS"] === "1",
  }),
);

export const screen = Screen.make({ css, width: 1440, height: 1000 }).pipe(
  Takumi.frames({
    fonts,
    // Paths, not URLs: the happy-dom environment (see screens.e2e.test.tsx) replaces the global `URL`.
    baselines: join(import.meta.dirname, "baselines"),
    output: join(import.meta.dirname, "../artifacts/stories"),
    update: process.env["UPDATE_SCREENS"] === "1",
  }),
);

type Router = ReturnType<typeof createConsoleRouter>;

/** The router the mounted app made, so a step can wait for its navigation to finish. */
const mounted: { router: Router | undefined } = { router: undefined };

/** The app's routes at `url`, under the story's client, in a theme. */
export const App = ({ url, theme }: { readonly url: string; readonly theme: "light" | "dark" }) => {
  const [router] = useState(() => {
    const made = createConsoleRouter(
      { clientOf: () => undefined },
      createMemoryHistory({ initialEntries: [url] }),
    );
    mounted.router = made;
    return made;
  });
  return (
    <div
      className={`${theme === "dark" ? "dark " : ""}flex min-h-full w-full flex-col bg-bg font-sans text-body text-fg`}
    >
      <NowProvider value={NOW}>
        <RouterProvider router={router} />
      </NowProvider>
    </div>
  );
};

/** Whether the mounted page shows what it will show: routed, rendered, nothing still loading. */
const settledPage = () => {
  const router = mounted.router;
  if (router === undefined || router.state.status !== "idle" || router.state.isLoading)
    return false;
  if (document.querySelector("main, [aria-labelledby='sign-in-title']") === null) return false;
  if (document.querySelector('[role="status"][aria-label^="Loading"], .animate-pulse') !== null)
    return false;
  return true;
};

/**
 * Waits, by condition and never by a fixed time, until the page is what a frame should show:
 * the router has loaded its (code-split) routes, every read is quiet, every result download has
 * arrived, nothing shows a loading placeholder, and the DOM did not change across two checks.
 * Neither routing nor downloads are story I/O, so the world's quiet alone does not cover them.
 * React flushes inside `act` while it waits. Under load this simply takes more rounds.
 */
export const loaded = Story.step("the page settles", async (world) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  try {
    let previous = "";
    let stable = 0;
    // A bound only so a broken page fails instead of hanging; under load it just takes longer.
    const until = Date.now() + 240_000;
    while (Date.now() < until) {
      await act(async () => {
        await downloads();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await world.settle();
      const now = document.body.innerHTML;
      stable = settledPage() && now === previous ? stable + 1 : 0;
      previous = now;
      if (stable >= 2) return;
    }
    const router = mounted.router;
    const waiting = document.querySelector(
      '[role="status"][aria-label^="Loading"], .animate-pulse',
    );
    throw new Story.Mismatch("the page never settled", [
      `router: ${router?.state.status ?? "none"}${router?.state.isLoading === true ? " (loading)" : ""}`,
      `landmark: ${document.querySelector("main, [aria-labelledby='sign-in-title']") === null ? "missing" : "present"}`,
      `still loading: ${waiting === null ? "nothing" : (waiting.getAttribute("aria-label") ?? waiting.outerHTML.slice(0, 200))}`,
    ]);
  } finally {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

/** A frame of the page at `url`, once its reads and downloads have settled. */
export const page = (
  name: string,
  url: string,
  theme: "light" | "dark",
  on: typeof screen = screen,
) =>
  consoleStory.with({ name: `${name} ${theme}${on === phone ? " phone" : ""}` })(
    on.render(<App url={url} theme={theme} />, { every: false }),
    loaded,
    on.shot(theme),
  );
