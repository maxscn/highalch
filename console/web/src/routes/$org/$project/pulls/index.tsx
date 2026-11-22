import { createFileRoute } from "@tanstack/react-router";
import { PullsScreen } from "../../../../screens/pulls.tsx";

export const Route = createFileRoute("/$org/$project/pulls/")({
  component: () => {
    const { org, project } = Route.useParams();
    return <PullsScreen org={org} project={project} />;
  },
});
