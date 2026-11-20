import { Predicate } from "effect";
import type { Invariant } from "../invariants";
import { json } from "../world";
import { clients, type Clients, type Shown } from "./state";

const brief = (shown: Shown) => `${json(shown.row)}${shown.pending ? " (pending)" : ""}`;

/** Whether the world is at rest now: settled since the last change, every run ended, feeds live. */
const atRest = (db: Clients) =>
  db.world.settled === db.world.tick &&
  db.runs.every((run) => !Predicate.isTagged(run.outcome, "Pending")) &&
  db.world.all().every((wire) => !wire.dropped);

/** Nothing pending at rest: every command ended and every feed is live, so no row is pending. */
export const nothingPending: Invariant = {
  name: "nothing pending at rest",
  check: async (stage, moment) => {
    const db = await stage.use(clients);

    if (!atRest(db) && !moment.final) return [];

    return db.observed().flatMap((observed) =>
      [...observed.rows].flatMap(([key, shown]) => {
        if (!shown.pending) return [];

        return [`${observed.label} still shows ${key} pending: ${brief(shown)}`];
      }),
    );
  },
};

/**
 * The invariants the story's connector adds for its clients (LowAlch's judge rows against the
 * feed: no flicker back, subsets agree, a rejection restores the row). Each violation names the
 * invariant it breaks.
 */
export const connected: Invariant = {
  name: "the clients' own invariants",
  check: async (stage, moment) => {
    const db = await stage.use(clients);
    const violations: Array<string> = [];

    for (const invariant of db.connector.invariants)
      for (const violation of await invariant.check(stage, moment))
        violations.push(`${invariant.name}: ${violation}`);

    return violations;
  },
};

/** The default invariants of a story's clients: nothing pending at rest, and the connector's. */
export const invariants: ReadonlyArray<Invariant> = [nothingPending, connected];
