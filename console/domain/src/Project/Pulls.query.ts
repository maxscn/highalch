import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { readableProject } from "../Reads.ts";
import { Project } from "./Project.aggregate.ts";
import { ProjectId } from "./Project.id.ts";
import { ProjectMissing } from "./ProjectMissing.rejection.ts";
import { PullRow, pullRow } from "./Source.rows.ts";
import { SourceHistory } from "./SourceHistory.view.ts";

/** A project's pull requests, as its uploads reported them, most recently active first. */
export class Pulls extends Domain.Query(
  "Pulls",
  {
    input: { project: ProjectId },
    success: Schema.Array(PullRow),
    middleware: [Caller],
    rejects: [NotAllowed, ProjectMissing],
  },
  { description: "A project's pull requests and the commits that had runs on them." },
) {}

export const PullsLive = Pulls.toLayer(
  Effect.gen(function* () {
    const readable = readableProject(yield* Project);
    const history = yield* SourceHistory;
    return Effect.fn("Pulls")(function* ({ project }) {
      const { org } = yield* readable(project);
      // reading without `atLeast` cannot time out
      const state = yield* history.get(project).pipe(Effect.orDie);
      return Option.match(state, {
        onNone: () => [],
        onSome: ({ pulls }) => [...pulls].reverse().map((pull) => pullRow(org, project, pull)),
      });
    });
  }),
);
