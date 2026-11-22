import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { InvalidCursor } from "../InvalidCursor.rejection.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { Project } from "../Project/Project.aggregate.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { ProjectMissing } from "../Project/ProjectMissing.rejection.ts";
import { nextOf, readableProject, seqOf } from "../Reads.ts";
import { RunId } from "../Run/Run.id.ts";
import { SubjectResultRow, subjectResultId } from "./SubjectResult.rows.ts";
import { SubjectResults } from "./SubjectResults.stream.ts";

/** One subject's results per compared run, newest first, optionally on one branch. */
export class SubjectHistory extends Domain.Query(
  "SubjectHistory",
  {
    input: {
      project: ProjectId,
      subject: Schema.String,
      branch: Schema.optionalKey(Schema.String),
    },
    success: SubjectResultRow,
    paged: true,
    middleware: [Caller],
    rejects: [NotAllowed, ProjectMissing, InvalidCursor],
  },
  { description: "A subject's results in each compared run, newest first." },
) {}

export const SubjectHistoryLive = SubjectHistory.toLayer(
  Effect.gen(function* () {
    const readable = readableProject(yield* Project);
    const results = yield* SubjectResults;
    return Effect.fn("SubjectHistory")(function* ({ project, subject, branch }, page) {
      yield* readable(project);
      const after = yield* seqOf(page.after);
      const listed = yield* results.list(project, {
        where: { subject, ...(branch === undefined ? {} : { branch }) },
        order: "desc",
        take: page.take,
        ...(after === undefined ? {} : { after }),
      });
      return {
        entries: listed.entries.map(({ event }) => {
          const { _tag: _, ...result } = event;
          return {
            ...result,
            id: subjectResultId(result.run, result.subject),
            run: RunId.make(result.run),
          };
        }),
        cursor: nextOf(listed),
      };
    });
  }),
);
