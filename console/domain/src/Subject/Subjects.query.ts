import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { Project } from "../Project/Project.aggregate.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { ProjectMissing } from "../Project/ProjectMissing.rejection.ts";
import { readableProject } from "../Reads.ts";
import { ProjectSubjects } from "./ProjectSubjects.view.ts";
import { SubjectKind } from "./Subject.ts";
import { SubjectRow } from "./Subject.rows.ts";

/** A project's subjects with their latest results, by kind then name. */
export class Subjects extends Domain.Query(
  "Subjects",
  {
    input: { project: ProjectId, kind: Schema.optionalKey(SubjectKind) },
    success: Schema.Array(SubjectRow),
    middleware: [Caller],
    rejects: [NotAllowed, ProjectMissing],
  },
  { description: "A project's components, parts and pages with their latest results." },
) {}

export const SubjectsLive = Subjects.toLayer(
  Effect.gen(function* () {
    const readable = readableProject(yield* Project);
    const subjects = yield* ProjectSubjects;
    return Effect.fn("Subjects")(function* ({ project, kind }) {
      const { org } = yield* readable(project);
      // reading without `atLeast` cannot time out
      const state = yield* subjects.get(project).pipe(Effect.orDie);
      return Option.match(state, {
        onNone: () => [],
        onSome: (found) =>
          found.subjects
            .filter((s) => kind === undefined || s.kind === kind)
            .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
            .map((s) => ({ ...s, org, project })),
      });
    });
  }),
);
