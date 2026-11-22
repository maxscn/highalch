import { me } from "@highalch/console-domain/Console.collections";
import * as HighAlch from "@lowalch/tanstack-db";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { ScopeClient } from "../components/client.tsx";
import { Failed } from "../components/states.tsx";
import { Logo } from "../components/icons.tsx";

export const Route = createFileRoute("/")({
  component: () => (
    <ScopeClient scope="">
      <Home />
    </ScopeClient>
  ),
});

/** Who is signed in decides where to go: their first organisation, else sign-in. */
const Home = () => {
  const result = useLiveQuery((q) => q.from({ me: me({}) }).findOne());
  return HighAlch.match(result).on({
    [HighAlch.anyOf("Loading", "Retrying")]: () => <Splash />,
    Ready: ({ data }) => {
      const first = [...data.organizations].sort((a, b) => a.name.localeCompare(b.name))[0];
      return first === undefined ? (
        <NoOrganization />
      ) : (
        <Navigate to="/$org" params={{ org: first.org }} replace />
      );
    },
    Missing: () => <Navigate to="/sign-in" replace />,
    orElse: (error, { retry }) => (
      <div className="grid min-h-screen place-items-center">
        <Failed error={error} retry={retry} />
      </div>
    ),
  });
};

const Splash = () => (
  <div
    role="status"
    aria-label="Loading HighAlch Console"
    className="grid min-h-screen place-items-center"
  >
    <Logo />
  </div>
);

const NoOrganization = () => (
  <div className="grid min-h-screen place-items-center px-4">
    <p className="max-w-prose text-body text-fg-muted">
      You are not a member of any organisation yet. Ask an owner to add you.
    </p>
  </div>
);
