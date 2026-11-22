import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Caller } from "../Caller.middleware.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { UserId } from "../Ids.ts";
import { NotAllowed } from "../NotAllowed.rejection.ts";
import { UserOrganization, UserOrganizations } from "./UserOrganizations.view.ts";

/** The signed-in user and the organisations they belong to. */
export const MeRow = Schema.Struct({
  user: Schema.Struct({ id: UserId, email: Schema.String, name: Schema.NullOr(Schema.String) }),
  organizations: Schema.Array(UserOrganization),
});
export type MeRow = typeof MeRow.Type;

/** Who is signed in, and where they may go. Only a browser session has a user. */
export class Me extends Domain.Query(
  "Me",
  { input: {}, success: MeRow, middleware: [Caller], rejects: [NotAllowed] },
  { description: "The signed-in user and their organisations." },
) {}

export const MeLive = Me.toLayer(
  Effect.gen(function* () {
    const memberships = yield* UserOrganizations;
    return Effect.fn("Me")(function* () {
      const actor = yield* CurrentActor;
      if (actor._tag !== "User") return yield* new NotAllowed();
      // reading without `atLeast` cannot time out
      const joined = yield* memberships.get(actor.user).pipe(Effect.orDie);
      return {
        user: { id: actor.user, email: actor.email, name: actor.name },
        organizations: Option.match(joined, {
          onNone: () => [],
          onSome: (state) => state.organizations,
        }),
      };
    });
  }),
);
