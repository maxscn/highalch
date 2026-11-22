import * as Domain from "@alchemy.run/domain";
import { Organization, OrganizationState } from "./Organization.aggregate.ts";

type Fold = (s: OrganizationState, e: unknown, envelope: unknown) => OrganizationState;
const folds = Organization.definition.evolve as unknown as Record<string, Fold>;

/**
 * An organisation's state after each of its events: the source of its organisation, member and
 * billing rows. Internal: clients read those rows.
 */
export class OrganizationOverview extends Domain.View(
  "OrganizationOverview",
  {
    from: [Organization],
    key: Organization,
    state: OrganizationState,
    initial: { _tag: "Unborn" },
    evolve: {
      Organization: (state, event, { envelope }) =>
        folds[event._tag]?.(state, event, envelope) ?? state,
    },
  },
  { description: "An organisation's members, plan, period and usage." },
) {}
