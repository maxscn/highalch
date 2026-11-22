import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { RunScreen } from "../../../../../screens/run.tsx";

const Search = Schema.toStandardSchemaV1(
  Schema.Struct({
    test: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Literals(["failed", "flaky", "passed", "changed"])),
    q: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/$org/$project/runs/$run/")({
  validateSearch: Search,
  component: () => {
    const { org, project, run } = Route.useParams();
    const search = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    return (
      <RunScreen
        org={org}
        project={project}
        run={run}
        search={search}
        onSearch={(next) => void navigate({ search: next, replace: true })}
      />
    );
  },
});
