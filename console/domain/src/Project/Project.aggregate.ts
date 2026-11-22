import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isMember } from "../Actor.ts";
import { maxApiKeys } from "../Billing/Plan.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Millis } from "../Ids.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { sameTarget } from "../TargetMismatch.rejection.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { CreateProject, ProjectCreated, ProjectExists } from "./CreateProject.command.ts";
import { ApiKeyIssued, IssueApiKey, TooManyApiKeys } from "./IssueApiKey.command.ts";
import { BindRepository, RepositoryBound } from "./BindRepository.command.ts";
import { ProjectId, RepositoryId } from "./Project.id.ts";
import { ProjectMissing } from "./ProjectMissing.rejection.ts";
import { ApiKeyMissing, ApiKeyRevoked, RevokeApiKey } from "./RevokeApiKey.command.ts";

export const ApiKeyRecord = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  prefix: Schema.String,
  hash: Schema.String,
  createdAt: Millis,
});
export type ApiKeyRecord = typeof ApiKeyRecord.Type;

export const ActiveProject = Schema.TaggedStruct("Active", {
  org: OrganizationId,
  repository: Schema.NullOr(RepositoryId),
  defaultBranch: Schema.String,
  createdAt: Millis,
  keys: Schema.Array(ApiKeyRecord),
});
export type ActiveProject = typeof ActiveProject.Type;

export const ProjectState = Schema.Union([Schema.TaggedStruct("Unborn", {}), ActiveProject]);
export type ProjectState = typeof ProjectState.Type;

const active = (s: ProjectState): ActiveProject | ProjectMissing =>
  s._tag === "Active" ? s : new ProjectMissing();

/** Members of the owning organisation manage a project (and the server itself). */
const manages = Effect.fn(function* (org: string) {
  const actor = yield* CurrentActor;
  return actor._tag === "System" || isMember(actor, org);
});

export class Project extends Domain.Aggregate("Project", {
  id: ProjectId,
  state: ProjectState,
  initial: { _tag: "Unborn" },
  commands: [CreateProject, IssueApiKey, RevokeApiKey, BindRepository],
  decide: {
    CreateProject: Effect.fn(function* (s, cmd, { id }) {
      yield* sameTarget(cmd.slug, id);
      if (!(yield* manages(cmd.org))) return yield* new NotAllowed();
      if (s._tag !== "Unborn") return yield* new ProjectExists();
      return [
        new ProjectCreated({
          org: cmd.org,
          repository: cmd.repository,
          defaultBranch: cmd.defaultBranch,
        }),
      ];
    }),
    IssueApiKey: Effect.fn(function* (s, cmd, { id }) {
      yield* sameTarget(cmd.project, id);
      const p = active(s);
      if (p._tag !== "Active") return yield* p;
      if (!(yield* manages(p.org))) return yield* new NotAllowed();
      if (p.keys.some((k) => k.key === cmd.key)) return [];
      if (p.keys.length >= maxApiKeys) return yield* new TooManyApiKeys({ max: maxApiKeys });
      return [
        new ApiKeyIssued({
          org: p.org,
          key: cmd.key,
          name: cmd.name,
          prefix: cmd.prefix,
          hash: cmd.hash,
        }),
      ];
    }),
    BindRepository: Effect.fn(function* (s, cmd, { id }) {
      yield* sameTarget(cmd.project, id);
      const p = active(s);
      if (p._tag !== "Active") return yield* p;
      if (!(yield* manages(p.org))) return yield* new NotAllowed();
      if (p.repository === cmd.repository) return [];
      return [
        new RepositoryBound({
          org: p.org,
          repository: cmd.repository,
          defaultBranch: p.defaultBranch,
          createdAt: p.createdAt,
        }),
      ];
    }),
    RevokeApiKey: Effect.fn(function* (s, cmd, { id }) {
      yield* sameTarget(cmd.project, id);
      const p = active(s);
      if (p._tag !== "Active") return yield* p;
      if (!(yield* manages(p.org))) return yield* new NotAllowed();
      if (!p.keys.some((k) => k.key === cmd.key)) return yield* new ApiKeyMissing();
      return [new ApiKeyRevoked({ org: p.org, key: cmd.key })];
    }),
  },
  evolve: {
    ProjectCreated: (_, e, envelope) => ({
      _tag: "Active" as const,
      org: e.org,
      repository: e.repository,
      defaultBranch: e.defaultBranch,
      createdAt: DateTime.toEpochMillis(envelope.at),
      keys: [],
    }),
    ApiKeyIssued: (s, e, envelope) =>
      s._tag === "Active"
        ? {
            ...s,
            keys: [
              ...s.keys,
              {
                key: e.key,
                name: e.name,
                prefix: e.prefix,
                hash: e.hash,
                createdAt: DateTime.toEpochMillis(envelope.at),
              },
            ],
          }
        : s,
    RepositoryBound: (s, e) => (s._tag === "Active" ? { ...s, repository: e.repository } : s),
    ApiKeyRevoked: (s, e) =>
      s._tag === "Active" ? { ...s, keys: s.keys.filter((k) => k.key !== e.key) } : s,
  },
}) {}
