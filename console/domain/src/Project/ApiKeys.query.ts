import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mayFollow } from "../Actor.ts";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { allow } from "../Reads.ts";
import { ApiKeyRow, apiKeyRow } from "./ApiKey.rows.ts";
import { Project } from "./Project.aggregate.ts";
import { ProjectId } from "./Project.id.ts";
import { ProjectMissing } from "./ProjectMissing.rejection.ts";

/** A project's active API keys, without secrets: for members of its organisation only. */
export class ApiKeys extends Domain.Query(
  "ApiKeys",
  {
    input: { project: ProjectId },
    success: Schema.Array(ApiKeyRow),
    middleware: [Caller],
    rejects: [NotAllowed, ProjectMissing],
  },
  { description: "A project's active API keys (names and prefixes, never secrets)." },
) {}

export const ApiKeysLive = ApiKeys.toLayer(
  Effect.gen(function* () {
    const projects = yield* Project;
    return Effect.fn("ApiKeys")(function* ({ project }) {
      const state = yield* projects.get(project);
      if (state._tag !== "Active") return yield* new ProjectMissing();
      yield* allow(mayFollow(yield* CurrentActor, state.org));
      return state.keys.map((key) => apiKeyRow(project, state, key));
    });
  }),
);
