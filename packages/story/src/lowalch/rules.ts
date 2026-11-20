import { Option, Predicate } from "effect";
import type { Rule } from "../rules";
import { clients, type Clients, type Observed, type Run, type Shown } from "../tanstack-db/state";
import { json } from "../world";
import { entityOf, entries as entriesIn, type Entry } from "./connector";

/** The `seq`s of the feed entries that carried exactly this row of this entity's key. */
const seqsOf = (entries: ReadonlyArray<Entry>, entity: string, key: string, shown: Shown) =>
  entries.flatMap((entry) => {
    const same = Option.match(entry.row, {
      onNone: () => false,
      onSome: (row) => json(row) === json(shown.row),
    });

    if (entry.entity !== entity || entry.key !== key || !same) return [];

    return [entry.seq];
  });

/** The observed sources of an entity, with their entity's name. */
const subsets = (db: Clients) =>
  db.observed().flatMap((observed) =>
    Option.match(entityOf(observed), {
      onNone: () => [],
      onSome: (entity) => [{ observed, entity: entity.entityName }],
    }),
  );

/** The feed entries of a scope, read once per check. */
const entriesOf = async (db: Clients, scope: string, cache: Map<string, ReadonlyArray<Entry>>) => {
  const known = cache.get(scope);

  if (known) return known;

  const read = await entriesIn(db, scope);

  cache.set(scope, read);

  return read;
};

const brief = (shown: Shown) => `${json(shown.row)}${shown.pending ? " (pending)" : ""}`;

/**
 * No flicker back: once a source showed a row of the feed at `seq`, it never shows an older one
 * for that key (rows the feed never carried, such as pending ones, are not judged). And once a
 * command's optimistic row showed, the source never shows a row older than the command's own
 * change after it (no "new → old → new" when the command settles).
 */
export const noFlickerBack: Rule = {
  name: "a row never flickers back",
  at: "step",
  check: async (stage) => {
    const db = await stage.use(clients);

    const cache = new Map<string, ReadonlyArray<Entry>>();
    const violations: Array<string> = [];

    for (const { observed, entity } of subsets(db)) {
      const entries = await entriesOf(db, observed.scope, cache);
      const keys = new Set(observed.history.map((each) => each.key));

      for (const key of keys) {
        let last = 0;

        for (const each of observed.history) {
          if (each.key !== key || Option.isNone(each.shown) || each.shown.value.pending) continue;

          const seqs = seqsOf(entries, entity, key, each.shown.value);

          if (seqs.length === 0) continue;

          const next = seqs.find((seq) => seq >= last);

          if (next === undefined) {
            violations.push(
              `${observed.label} showed ${key} as ${brief(each.shown.value)} (seq ${Math.max(...seqs)}) after a newer row (seq ${last}), in step ${each.step}`,
            );
            break;
          }

          last = next;
        }
      }

      for (const run of db.runs) {
        const committed = Predicate.isTagged(run.outcome, "Committed");

        if (run.scope !== observed.scope || !committed || run.key === "") continue;

        const caused = entries.flatMap((entry) => {
          const own =
            entry.commandId === run.transaction.id ||
            entry.commandId.startsWith(`${run.transaction.id}:`);

          if (entry.key !== run.key || entry.entity !== entity || !own) return [];

          return [entry.seq];
        });

        if (caused.length === 0) continue;

        const own = Math.max(...caused);

        const anchor = observed.history.findIndex(
          (each) =>
            each.tick > run.tick &&
            each.key === run.key &&
            Option.isSome(each.shown) &&
            each.shown.value.pending,
        );

        if (anchor < 0) continue;

        for (const each of observed.history.slice(anchor)) {
          if (each.key !== run.key || Option.isNone(each.shown) || each.shown.value.pending)
            continue;

          const seqs = seqsOf(entries, entity, run.key, each.shown.value);

          if (seqs.some((seq) => seq >= own)) continue;

          violations.push(
            `${observed.label} showed ${run.key} as ${brief(each.shown.value)} (${
              seqs.length > 0 ? `seq ${Math.max(...seqs)}` : "a row the feed never carried"
            }) after ${run.label} showed its change, which the feed carried at seq ${own} (step ${each.step})`,
          );
          break;
        }
      }
    }

    return violations;
  },
};

/** At rest, every ready subset of an entity in one client that shows a row shows the same row. */
export const subsetsAgree: Rule = {
  name: "every subset of an entity agrees on a row",
  at: "rest",
  check: async (stage) => {
    const db = await stage.use(clients);

    const groups = new Map<string, Array<Observed>>();

    for (const { observed, entity } of subsets(db)) {
      if (!Predicate.isTagged(observed.state(), "Ready")) continue;

      const group = `${observed.scope}/${entity}`;
      const members = groups.get(group) ?? [];

      members.push(observed);
      groups.set(group, members);
    }

    const violations: Array<string> = [];

    for (const members of groups.values())
      for (const [index, first] of members.entries())
        for (const second of members.slice(index + 1))
          for (const [key, shown] of first.rows) {
            const other = second.rows.get(key);

            if (other && json(other.row) !== json(shown.row))
              violations.push(
                `${first.label} shows ${key} as ${brief(shown)}, ${second.label} as ${brief(other)}`,
              );
          }

    return violations;
  },
};

const judged = new WeakMap<Clients, Set<Run>>();

/**
 * A rejected command leaves the value it found: right after its rejection, each source that showed
 * its row shows what it showed before the command (or a newer row of the feed), not pending.
 */
export const rejectedRestores: Rule = {
  name: "a rejection restores the row",
  at: "step",
  check: async (stage) => {
    const db = await stage.use(clients);

    const done = judged.get(db) ?? new Set<Run>();
    const cache = new Map<string, ReadonlyArray<Entry>>();
    const violations: Array<string> = [];

    judged.set(db, done);

    for (const run of db.runs) {
      if (!Predicate.isTagged(run.outcome, "Rejected") || done.has(run) || run.key === "") continue;

      done.add(run);

      const busy = db.runs.some(
        (other) =>
          other !== run &&
          other.key === run.key &&
          other.scope === run.scope &&
          Predicate.isTagged(other.outcome, "Pending"),
      );

      if (busy) continue;

      for (const { observed, entity } of subsets(db)) {
        if (observed.scope !== run.scope) continue;

        const before = Option.fromUndefinedOr(run.before.get(observed.id)?.get(run.key));
        const now = Option.fromUndefinedOr(observed.rows.get(run.key));

        if (Option.isNone(before) && Option.isNone(now)) continue;

        if (Option.isSome(now) && now.value.pending) {
          violations.push(
            `${observed.label} still shows ${run.key} pending after ${run.label} was rejected`,
          );
          continue;
        }

        if (Option.isSome(before) && Option.isSome(now)) {
          if (json(before.value.row) === json(now.value.row)) continue;

          const entries = await entriesOf(db, observed.scope, cache);
          const was = Math.max(0, ...seqsOf(entries, entity, run.key, before.value));
          const is = seqsOf(entries, entity, run.key, now.value);

          if (is.some((seq) => seq >= was)) continue;
        }

        violations.push(
          `after ${run.label} was rejected, ${observed.label} shows ${run.key} as ${Option.match(
            now,
            {
              onNone: () => "nothing",
              onSome: brief,
            },
          )}; before it, ${Option.match(before, { onNone: () => "nothing", onSome: brief })}`,
        );
      }
    }

    return violations;
  },
};

/** The rules of LowAlch clients, judged against the feed's own entries. */
export const fed: ReadonlyArray<Rule> = [noFlickerBack, subsetsAgree, rejectedRestores];
