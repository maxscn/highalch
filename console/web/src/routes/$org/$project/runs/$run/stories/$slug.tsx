import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { StoryScreen } from "../../../../../../screens/story.tsx";

const Search = Schema.toStandardSchemaV1(Schema.Struct({ step: Schema.optional(Schema.Int) }));

export const Route = createFileRoute("/$org/$project/runs/$run/stories/$slug")({
  validateSearch: Search,
  component: () => {
    const { org, project, run, slug } = Route.useParams();
    const { step } = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    return (
      <StoryScreen
        org={org}
        project={project}
        run={run}
        slug={slug}
        step={step}
        onStep={(next) => void navigate({ search: { step: next }, replace: true })}
      />
    );
  },
});
