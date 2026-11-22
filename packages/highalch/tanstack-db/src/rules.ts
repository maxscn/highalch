import { due, type Rule } from "@highalch/story/internal";
import { json } from "@highalch/story/internal";
import { clients, type Shown } from "./state";

const brief = (shown: Shown) => `${json(shown.row)}${shown.pending ? " (pending)" : ""}`;

/** Nothing pending at rest: every command ended and every feed is live, so no row is pending. */
export const nothingPending: Rule = {
  name: "nothing is pending at rest",
  at: "rest",
  check: async (stage) => {
    const db = await stage.use(clients);

    return db.observed().flatMap((observed) =>
      [...observed.rows].flatMap(([key, shown]) => {
        if (!shown.pending) return [];

        return [`${observed.label} still shows ${key} pending: ${brief(shown)}`];
      }),
    );
  },
};

/**
 * The rules the story's connector adds for its clients (LowAlch's judge rows against the feed: a
 * row never flickers back, subsets agree, a rejection restores the row), each checked at its own
 * moment. Each violation names the rule it breaks.
 */
export const connected: Rule = {
  name: "the clients' own rules hold",
  at: "step",
  check: async (stage, moment) => {
    const db = await stage.use(clients);
    const violations: Array<string> = [];

    for (const rule of db.connector.rules) {
      if (!due(rule, moment)) continue;

      for (const violation of await rule.check(stage, moment))
        violations.push(`"${rule.name}": ${violation}`);
    }

    return violations;
  },
};

/** The default rules of a story's clients: nothing pending at rest, and the connector's. */
export const rules: ReadonlyArray<Rule> = [nothingPending, connected];
