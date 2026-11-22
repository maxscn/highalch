import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Schema from "effect/Schema";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { ProjectId } from "../Project/Project.id.ts";
import { RunId } from "../Run/Run.id.ts";
import { RunDetail } from "../Run/RunDetail.view.ts";
import { StoryHeader, StorySummary, type StoryHeader as Header } from "./Story.values.ts";

/** `<run>/<slug>`: a story of a run. */
export const storyId = (run: string, slug: string) => `${run}/${slug}`;

/**
 * A story of a run, with what a story list shows: its run's commit, branch and pull request,
 * its steps by status, their kinds and its frames by status. Its steps themselves are in its
 * report (`report`, the `story.json` artifact; read it through `ArtifactLinks`).
 */
export const StoryRow = Schema.Struct({
  id: Schema.String,
  run: RunId,
  org: OrganizationId,
  project: ProjectId,
  commit: Schema.String,
  branch: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  ...StoryHeader.fields,
  ...StorySummary.fields,
});
export type StoryRow = typeof StoryRow.Type;

/** A story row from its run and its report's summary. */
export const storyRow = (
  run: {
    readonly id: RunId;
    readonly commit: string;
    readonly branch: string;
    readonly pr: number | null;
  },
  recorded: {
    readonly org: OrganizationId;
    readonly project: ProjectId;
    readonly story: Header;
    readonly summary: StorySummary;
  },
): StoryRow => ({
  id: storyId(run.id, recorded.story.slug),
  run: run.id,
  org: recorded.org,
  project: recorded.project,
  commit: run.commit,
  branch: run.branch,
  pr: run.pr,
  ...recorded.story,
  ...recorded.summary,
});

/** The stories of an organisation's runs. */
export class StoryRows extends HighAlch.Rows("StoryRows", {
  feed: OrganizationChanges,
  row: StoryRow,
  key: "id",
  from: [RunDetail],
  scope: ({ state }) => (state?._tag === "Run" ? state.org : undefined),
  on: {
    StoryRecorded: (event, { source, state }) =>
      state?._tag === "Run"
        ? HighAlch.upserted(storyRow({ id: source.id, ...state }, event))
        : undefined,
  },
}) {}
