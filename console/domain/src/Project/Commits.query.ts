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
import { CommitRow, commitId } from "./Source.rows.ts";
import { SourceHistory } from "./SourceHistory.view.ts";

/** A project's commits, as its uploads reported them, newest first. */
export class Commits extends Domain.Query(
  "Commits",
  {
    input: { project: ProjectId },
    success: Schema.Array(CommitRow),
    middleware: [Caller],
    rejects: [NotAllowed, ProjectMissing],
  },
  { description: "A project's commits (message, author, time), newest first." },
) {}

export const CommitsLive = Commits.toLayer(
  Effect.gen(function* () {
    const readable = readableProject(yield* Project);
    const history = yield* SourceHistory;
    return Effect.fn("Commits")(function* ({ project }) {
      const { org } = yield* readable(project);
      // reading without `atLeast` cannot time out
      const state = yield* history.get(project).pipe(Effect.orDie);
      return Option.match(state, {
        onNone: () => [],
        onSome: ({ commits }) =>
          [...commits]
            .reverse()
            .map((c) => ({ id: commitId(project, c.sha), org, project, sha: c.sha, ...c.info })),
      });
    });
  }),
);
