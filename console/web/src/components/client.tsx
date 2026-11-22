import { Provider } from "@lowalch/tanstack-db/react";
import { useRouteContext } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * Mounts the client of `scope` (an organisation, or `""` before one is chosen) for everything
 * below: stock `useLiveQuery` reads and commands use it. Under a story, the router has no
 * clients and the story's own client (provided by `Screen.render`) is used instead.
 */
export const ScopeClient = ({
  scope,
  children,
}: {
  readonly scope: string;
  readonly children: ReactNode;
}) => {
  const client = useRouteContext({
    from: "__root__",
    select: (context) => context.clientOf(scope),
  });
  return client === undefined ? children : <Provider client={client}>{children}</Provider>;
};
