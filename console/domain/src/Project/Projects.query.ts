import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { boundProject, mayRead } from "../Actor.ts";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { allow } from "../Reads.ts";
import { OrganizationProjects } from "./OrganizationProjects.view.ts";
import { ProjectRow } from "./Project.rows.ts";

/** The projects of an organisation, oldest first; a project key sees its own project only. */
export class Projects extends Domain.Query(
  "Projects",
  {
    input: { org: OrganizationId },
    success: Schema.Array(ProjectRow),
    middleware: [Caller],
    rejects: [NotAllowed],
  },
  { description: "The projects of an organisation." },
) {}

export const ProjectsLive = Projects.toLayer(
  Effect.gen(function* () {
    const listed = yield* OrganizationProjects;
    return Effect.fn("Projects")(function* ({ org }) {
      const actor = yield* CurrentActor;
      yield* allow(mayRead(actor, org));
      const only = boundProject(actor);
      // reading without `atLeast` cannot time out
      const state = yield* listed.get(org).pipe(Effect.orDie);
      return Option.match(state, {
        onNone: () => [],
        onSome: ({ projects }) =>
          projects.filter((p) => only === undefined || p.slug === only).map((p) => ({ ...p, org })),
      });
    });
  }),
);
