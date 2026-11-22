import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { boundProject, mayRead } from "../Actor.ts";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { InvalidCursor } from "../InvalidCursor.rejection.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { Organization } from "../Organization/Organization.aggregate.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { allow, nextOf, seqOf } from "../Reads.ts";
import { OrganizationRuns } from "./OrganizationRuns.stream.ts";
import { Run } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";
import { RunRow, runRow } from "./Run.rows.ts";
import { Kind } from "./Run.values.ts";

interface Filter {
  readonly project: string | undefined;
  readonly commit: string | undefined;
  readonly branch: string | undefined;
  readonly pr: number | undefined;
  readonly kind: Kind | undefined;
}

/** A commit filter matches an abbreviated or a full sha either way. */
const matches = (filter: Filter, run: RunRow) =>
  (filter.project === undefined || run.project === filter.project) &&
  (filter.commit === undefined ||
    run.commit.startsWith(filter.commit) ||
    filter.commit.startsWith(run.commit)) &&
  (filter.branch === undefined || run.branch === filter.branch) &&
  (filter.pr === undefined || run.pr === filter.pr) &&
  (filter.kind === undefined || run.kind === filter.kind);

/**
 * An organisation's runs: the first page starts with every open run (newest first), then
 * completed runs, most recently completed first. Filtered by project, commit, branch, pull
 * request and kind (`stories` for story-only runs); a project key sees its own project only.
 */
export class Runs extends Domain.Query(
  "Runs",
  {
    input: {
      org: OrganizationId,
      project: Schema.optionalKey(ProjectId),
      commit: Schema.optionalKey(Schema.String),
      branch: Schema.optionalKey(Schema.String),
      pr: Schema.optionalKey(Schema.Number),
      kind: Schema.optionalKey(Kind),
    },
    success: RunRow,
    paged: true,
    middleware: [Caller],
    rejects: [NotAllowed, InvalidCursor],
  },
  { description: "An organisation's runs, open ones first, by project, commit, branch or PR." },
) {}

export const RunsLive = Runs.toLayer(
  Effect.gen(function* () {
    const organizations = yield* Organization;
    const runs = yield* Run;
    const completed = yield* OrganizationRuns;

    const rowOf = (id: RunId) =>
      Effect.map(runs.get(id), (state) => (state._tag === "Run" ? [runRow(id, state)] : []));

    const open = Effect.fn("Runs.open")(function* (org: OrganizationId, filter: Filter) {
      const state = yield* organizations.get(org);
      if (state._tag !== "Active") return [];
      const rows = yield* Effect.forEach(state.openRuns, (open) => rowOf(open.run), {
        concurrency: 8,
      });
      return rows
        .flat()
        .filter((run) => run.status === "running" && matches(filter, run))
        .sort((a, b) => b.createdAt - a.createdAt);
    });

    return Effect.fn("Runs")(function* (input, page) {
      const actor = yield* CurrentActor;
      const filter: Filter = {
        project: input.project ?? boundProject(actor),
        commit: input.commit,
        branch: input.branch,
        pr: input.pr,
        kind: input.kind,
      };
      yield* allow(mayRead(actor, input.org, filter.project));
      const after = yield* seqOf(page.after);
      const first = after === undefined ? yield* open(input.org, filter) : [];
      const listed = yield* completed.list(input.org, {
        where: {
          ...(filter.project === undefined ? {} : { project: ProjectId.make(filter.project) }),
          ...(filter.commit === undefined ? {} : { commit: { startsWith: filter.commit } }),
          ...(filter.branch === undefined ? {} : { branch: filter.branch }),
          ...(filter.pr === undefined ? {} : { pr: filter.pr }),
          ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        },
        order: "desc",
        take: page.take,
        ...(after === undefined ? {} : { after }),
      });
      const rows = yield* Effect.forEach(
        listed.entries,
        (entry) => rowOf(RunId.make(entry.event.run)),
        { concurrency: 8 },
      );
      return { entries: [...first, ...rows.flat()], cursor: nextOf(listed) };
    });
  }),
  { take: { default: 50, max: 200 } },
);
