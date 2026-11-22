import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { RunsScreen } from "../../../../screens/runs.tsx";

const Search = Schema.toStandardSchemaV1(
  Schema.Struct({
    q: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Literals(["failed", "flaky", "passed"])),
    kind: Schema.optional(Schema.Literals(["playwright", "fuzz", "stories"])),
  }),
);

export const Route = createFileRoute("/$org/$project/runs/")({
  validateSearch: Search,
  component: () => {
    const { org, project } = Route.useParams();
    const filter = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    return (
      <RunsScreen
        org={org}
        project={project}
        filter={filter}
        onFilter={(next) => void navigate({ search: next, replace: true })}
      />
    );
  },
});
