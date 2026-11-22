import * as Schema from "effect/Schema";
import { UserId } from "./Ids.ts";
import { OrganizationId } from "./Organization/Organization.id.ts";
import { ProjectId } from "./Project/Project.id.ts";
import { RunId } from "./Run/Run.id.ts";

export const Role = Schema.Literals(["owner", "member"]);
export type Role = typeof Role.Type;

export const Membership = Schema.Struct({ org: OrganizationId, role: Role });
export type Membership = typeof Membership.Type;

/** A signed-in dashboard user (from their session) and the organisations they belong to. */
export const UserActor = Schema.TaggedStruct("User", {
  user: UserId,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  memberships: Schema.Array(Membership),
});
export type UserActor = typeof UserActor.Type;

/** A project API key. */
export const KeyActor = Schema.TaggedStruct("Key", {
  org: OrganizationId,
  project: ProjectId,
  key: Schema.String,
});

/** Commit context verified by GitHub OIDC; it overrides what an uploader reports. */
export const VerifiedContext = Schema.Struct({
  commit: Schema.String,
  branch: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  baseBranch: Schema.NullOr(Schema.String),
});
export type VerifiedContext = typeof VerifiedContext.Type;

/**
 * An upload credential bound to a project: a GitHub OIDC token of the project's repository
 * (`run: null`, may create runs, carries the verified commit context), or one scoped to a run.
 */
export const UploaderActor = Schema.TaggedStruct("Uploader", {
  org: OrganizationId,
  project: ProjectId,
  run: Schema.NullOr(RunId),
  context: Schema.NullOr(VerifiedContext),
});
/** Trusted server code: webhooks, jobs, policies. */
export const SystemActor = Schema.TaggedStruct("System", { name: Schema.String });

export const Actor = Schema.Union([UserActor, KeyActor, UploaderActor, SystemActor]);
export type Actor = typeof Actor.Type;

export const system = (name: string): Actor => ({ _tag: "System", name });

export const isMember = (actor: Actor, org: string) =>
  actor._tag === "User" && actor.memberships.some((m) => m.org === org);

/** May read data of `org` (optionally narrowed to `project`). */
export const mayRead = (actor: Actor, org: string, project?: string) => {
  switch (actor._tag) {
    case "System":
      return true;
    case "User":
      return isMember(actor, org);
    case "Key":
    case "Uploader":
      return actor.org === org && (project === undefined || actor.project === project);
  }
};

/**
 * May follow the organisation's row feed, which carries every project's rows: its members and
 * the server. A key or upload credential reads its own project through queries instead.
 */
export const mayFollow = (actor: Actor, org: string) =>
  actor._tag === "System" || isMember(actor, org);

/** The one project a project-bound credential reads, if the actor is one. */
export const boundProject = (actor: Actor): string | undefined =>
  actor._tag === "Key" || actor._tag === "Uploader" ? actor.project : undefined;

/**
 * May write to `run` of `project` (`null`: open a new one). A GitHub OIDC credential writes any
 * run of its project; one scoped to a run writes only that run.
 */
export const mayUpload = (actor: Actor, org: string, project: string, run: string | null) => {
  switch (actor._tag) {
    case "System":
      return true;
    case "User":
      return false;
    case "Key":
      return actor.org === org && actor.project === project;
    case "Uploader":
      return (
        actor.org === org &&
        actor.project === project &&
        (actor.run === null || run === null || actor.run === run)
      );
  }
};
