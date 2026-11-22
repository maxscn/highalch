import { createFileRoute } from "@tanstack/react-router";
import { PullScreen } from "../../../../screens/pull.tsx";

/** A pull request opens on its latest run's overview. */
export const Route = createFileRoute("/$org/$project/pulls/$pull")({
  component: () => {
    const { org, project, pull } = Route.useParams();
    return <PullScreen org={org} project={project} pull={Number(pull)} />;
  },
});
