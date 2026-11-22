import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { RouterContext } from "../router.tsx";
import { themeScript } from "../lib/theme.ts";
import "../styles.css";

export const Route = createRootRouteWithContext<RouterContext>()({
  // The document shell renders on the server; every route renders in the browser (src/start.ts).
  ssr: false,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "HighAlch Console" },
    ],
    scripts: [{ children: themeScript }],
  }),
  shellComponent: ({ children }) => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ),
  component: Outlet,
});
