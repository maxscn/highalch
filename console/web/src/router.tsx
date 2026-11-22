import { createRouter, type RouterHistory } from "@tanstack/react-router";
import type { DbClient } from "@tanstack/db";
import { clientOf } from "./data/db.ts";
import { routeTree } from "./routeTree.gen";

/**
 * What routes read besides their params: the client of an organisation. The app makes one per
 * organisation (`clientOf` in `data/db.ts`); a story passes `undefined`, so routes render under
 * the story's own client (`Screen.render` provides it).
 */
export type RouterContext = {
  readonly clientOf: (org: string) => DbClient | undefined;
};

export const createConsoleRouter = (context: RouterContext, history?: RouterHistory) =>
  createRouter({
    routeTree,
    context,
    scrollRestoration: true,
    defaultPreload: false,
    ...(history === undefined ? {} : { history }),
  });

export const getRouter = () => createConsoleRouter({ clientOf });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
