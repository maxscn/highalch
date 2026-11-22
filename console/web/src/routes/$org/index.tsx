import { projects } from "@highalch/console-domain/Console.collections";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import * as HighAlch from "@lowalch/tanstack-db";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { Failed } from "../../components/states.tsx";

export const Route = createFileRoute("/$org/")({ component: () => <FirstProject /> });

/** An organisation opens on its oldest project's runs. */
const FirstProject = () => {
  const { org } = Route.useParams();
  const result = useLiveQuery((q) =>
    q
      .from({ project: projects.list({ org: OrganizationId.make(org) }) })
      .orderBy(({ project }) => project.createdAt)
      .findOne(),
  );
  return HighAlch.match(result).on({
    [HighAlch.anyOf("Loading", "Retrying")]: () => null,
    Ready: ({ data }) => (
      <Navigate to="/$org/$project/stories" params={{ org, project: data.slug }} replace />
    ),
    Missing: () => (
      <p className="p-8 text-body text-fg-muted">This organisation has no projects yet.</p>
    ),
    orElse: (error, { retry }) => <Failed error={error} retry={retry} />,
  });
};
