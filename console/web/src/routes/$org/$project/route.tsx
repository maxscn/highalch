import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Shell } from "../../../components/shell.tsx";

/** Every page of a project sits in the shell. */
export const Route = createFileRoute("/$org/$project")({
  component: () => {
    const { org, project } = Route.useParams();
    return (
      <Shell org={org} project={project}>
        <Outlet />
      </Shell>
    );
  },
});
