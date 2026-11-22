import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { VerifiedContext } from "./Actor.ts";
import { Caller } from "./Caller.middleware.ts";
import { CurrentActor } from "./CurrentActor.context.ts";
import { NotAllowed } from "./NotAllowed.rejection.ts";
import { OrganizationId } from "./Organization/Organization.id.ts";
import { ProjectId } from "./Project/Project.id.ts";

/** What an upload credential is bound to. */
export const CredentialRow = Schema.Struct({
  org: OrganizationId,
  project: ProjectId,
  /** The commit, branch and pull request GitHub OIDC verified, or `null` for an API key. */
  context: Schema.NullOr(VerifiedContext),
});
export type CredentialRow = typeof CredentialRow.Type;

/**
 * Who CI is: the organisation and project its API key or GitHub OIDC token uploads to, and the
 * verified commit context of an OIDC token. CI asks once per run, before `OpenRun`. Any other
 * caller (a browser session, the server) is refused.
 */
export class Credential extends Domain.Query(
  "Credential",
  { input: {}, success: CredentialRow, middleware: [Caller], rejects: [NotAllowed] },
  { description: "The organisation, project and verified commit context of a CI credential." },
) {}

export const CredentialLive = Credential.toLayer(
  Effect.succeed(
    Effect.fn("Credential")(function* () {
      const actor = yield* CurrentActor;
      switch (actor._tag) {
        case "Key":
          return { org: actor.org, project: actor.project, context: null };
        case "Uploader":
          return { org: actor.org, project: actor.project, context: actor.context };
        default:
          return yield* new NotAllowed();
      }
    }),
  ),
);
