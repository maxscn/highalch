import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Effect from "effect/Effect";
import { mayFollow } from "./Actor.ts";
import { Caller } from "./Caller.middleware.ts";
import { CurrentActor } from "./CurrentActor.context.ts";
import { NotAllowed } from "./NotAllowed.rejection.ts";
import { OrganizationId } from "./Organization/Organization.id.ts";

/**
 * The row feed of one organisation: every `*Rows` entity's changes, one stream per organisation,
 * written by `OrganizationChangesWriter`. Browsers follow it for the organisation they show.
 */
export class OrganizationChanges extends HighAlch.Feed("OrganizationChanges", {
  scope: OrganizationId,
  middleware: [Caller],
  rejects: [NotAllowed],
}) {}

/** Members of the organisation (and the server) follow its feed; keys and upload tokens do not. */
export const OrganizationChangesLive = OrganizationChanges.toLayer(
  Effect.succeed(
    Effect.fn(function* (request) {
      if (!mayFollow(yield* CurrentActor, request.key)) return yield* new NotAllowed();
    }),
  ),
);
