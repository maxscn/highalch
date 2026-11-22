import { createFileRoute } from "@tanstack/react-router";
import { SettingsScreen } from "../../../screens/settings.tsx";

export const Route = createFileRoute("/$org/$project/settings")({
  component: () => {
    const { org, project } = Route.useParams();
    return <SettingsScreen org={org} project={project} />;
  },
});
