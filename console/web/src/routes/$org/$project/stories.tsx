import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { StoriesScreen } from "../../../screens/stories.tsx";

const Search = Schema.toStandardSchemaV1(
  Schema.Struct({
    run: Schema.optional(Schema.String),
    filter: Schema.optional(Schema.Literals(["failed", "frames", "passed"])),
    q: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/$org/$project/stories")({
  validateSearch: Search,
  component: () => {
    const { org, project } = Route.useParams();
    const search = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    return (
      <StoriesScreen
        org={org}
        project={project}
        search={search}
        onSearch={(next) => void navigate({ search: next, replace: true })}
      />
    );
  },
});
