import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isMember } from "../Actor.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { sameTarget } from "../TargetMismatch.rejection.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import {
  ClaimRepository,
  ReleaseRepository,
  RepositoryClaimed,
  RepositoryReleased,
  RepositoryTaken,
} from "./ClaimRepository.command.ts";
import { ProjectId, RepositoryId } from "./Project.id.ts";

export const RepositoryState = Schema.Union([
  Schema.TaggedStruct("Free", {}),
  Schema.TaggedStruct("Claimed", { project: ProjectId, org: OrganizationId }),
]);
export type RepositoryState = typeof RepositoryState.Type;

export class Repository extends Domain.Aggregate("Repository", {
  id: RepositoryId,
  state: RepositoryState,
  initial: { _tag: "Free" },
  commands: [ClaimRepository, ReleaseRepository],
  decide: {
    ClaimRepository: Effect.fn(function* (s, cmd, { id }) {
      yield* sameTarget(cmd.repository, id);
      const actor = yield* CurrentActor;
      if (actor._tag !== "System" && !isMember(actor, cmd.org)) return yield* new NotAllowed();
      if (s._tag === "Claimed")
        return s.project === cmd.project ? [] : yield* new RepositoryTaken();
      return [new RepositoryClaimed({ project: cmd.project, org: cmd.org })];
    }),
    ReleaseRepository: Effect.fn(function* (s, cmd, { id }) {
      yield* sameTarget(cmd.repository, id);
      if (s._tag !== "Claimed" || s.project !== cmd.project) return [];
      const actor = yield* CurrentActor;
      if (actor._tag !== "System" && !isMember(actor, s.org)) return yield* new NotAllowed();
      return [new RepositoryReleased({ project: cmd.project })];
    }),
  },
  evolve: {
    RepositoryClaimed: (_, e) => ({ _tag: "Claimed" as const, project: e.project, org: e.org }),
    RepositoryReleased: () => ({ _tag: "Free" as const }),
  },
}) {}
