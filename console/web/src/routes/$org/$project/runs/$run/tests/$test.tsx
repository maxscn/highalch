import { createFileRoute } from "@tanstack/react-router";
import { TestScreen } from "../../../../../../screens/test.tsx";

export const Route = createFileRoute("/$org/$project/runs/$run/tests/$test")({
  component: () => {
    const { org, project, run, test } = Route.useParams();
    return <TestScreen org={org} project={project} run={run} test={test} />;
  },
});
