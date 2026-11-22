import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ScopeClient } from "../../components/client.tsx";

/** Everything of one organisation reads through its client (its `OrganizationChanges` feed). */
export const Route = createFileRoute("/$org")({
  component: () => {
    const { org } = Route.useParams();
    return (
      <ScopeClient scope={org}>
        <Outlet />
      </ScopeClient>
    );
  },
});
