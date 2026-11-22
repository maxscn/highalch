import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { OrganizationCreated } from "./CreateOrganization.command.ts";
import { Organization } from "./Organization.aggregate.ts";
import { RetentionDue, SweepRetention } from "./SweepRetention.command.ts";

/** Every organisation sweeps retention once a day, from its creation on (re-armed each pass). */
export class RetentionSchedule extends Domain.Policy("RetentionSchedule", {
  from: Organization,
  on: [OrganizationCreated, RetentionDue],
}) {}

export const RetentionScheduleLive = RetentionSchedule.toLayer(
  Effect.gen(function* () {
    const organizations = yield* Organization;
    return Effect.fn("RetentionSchedule")(function* ({ source }) {
      yield* organizations.schedule(source, new SweepRetention({}), {
        after: "1 day",
        commandId: `sweep:${source.id}`,
      });
    });
  }),
);
