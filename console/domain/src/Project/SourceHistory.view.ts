import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { Run } from "../Run/Run.aggregate.ts";
import { CommitInfo, PullInfo } from "../Run/Run.values.ts";
import { ProjectId } from "./Project.id.ts";

/** Bounds of the view's state: the newest commits and pull requests are kept. */
export const maxCommits = 500;
export const maxPulls = 200;
export const maxPullCommits = 250;

export const KnownCommit = Schema.Struct({ sha: Schema.String, info: CommitInfo });
export const KnownPull = Schema.Struct({
  number: Schema.Number,
  branch: Schema.String,
  info: PullInfo,
  /** Commit shas that had runs on the pull request, oldest first. */
  commits: Schema.Array(Schema.String),
});
export type KnownPull = typeof KnownPull.Type;

/**
 * A project's commits and pull requests as its uploads described them (latest report wins):
 * the dashboard's commit and pull request lists.
 */
export class SourceHistory extends Domain.View(
  "SourceHistory",
  {
    from: [Run],
    key: ProjectId,
    keyOf: { RunCreated: ({ event }) => event.project },
    state: Schema.Struct({
      org: Schema.NullOr(OrganizationId),
      commits: Schema.Array(KnownCommit),
      pulls: Schema.Array(KnownPull),
    }),
    initial: { org: null, commits: [], pulls: [] },
    evolve: {
      RunCreated: (state, e) => {
        const commits =
          e.commitInfo === null
            ? state.commits
            : [
                ...state.commits.filter((c) => c.sha !== e.commit),
                { sha: e.commit, info: e.commitInfo },
              ]
                .sort((a, b) => a.info.committedAt.localeCompare(b.info.committedAt))
                .slice(-maxCommits);
        if (e.pr === null || e.pull === null) return { ...state, org: e.org, commits };
        const previous = state.pulls.find((p) => p.number === e.pr);
        const pull: KnownPull = {
          number: e.pr,
          branch: e.branch,
          info: e.pull,
          commits: [...(previous?.commits ?? []).filter((sha) => sha !== e.commit), e.commit].slice(
            -maxPullCommits,
          ),
        };
        return {
          org: e.org,
          commits,
          pulls: [...state.pulls.filter((p) => p.number !== e.pr), pull].slice(-maxPulls),
        };
      },
    },
  },
  { description: "A project's commits and pull requests, as its uploads reported them." },
) {}
