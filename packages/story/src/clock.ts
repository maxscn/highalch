import type { Timers, Wait } from "@highalch/tanstack-db/internal";

/** One timer a story's clients started, waiting for its time. */
type Pending = {
  readonly id: number;
  readonly at: number;
  readonly wait: Wait;
  readonly run: () => void;
};

/**
 * The clock a story's clients schedule their waits on (retries, reload debounces, settle
 * timeouts). `manual`: nothing fires until the story advances it, so a story decides when a retry
 * or a timeout happens. `real`: the global `setTimeout`, with the waits still tracked so the story
 * knows when something is about to happen.
 */
export class Clock {
  now = 0;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(readonly mode: "manual" | "real") {}

  /** The `timers` a client is given. */
  readonly timers: Timers = {
    set: (run, ms, wait) => {
      const id = (this.sequence += 1);

      if (this.mode === "real") {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          run();
        }, ms);

        this.pending.set(id, { id, at: this.now + ms, wait, run });

        return () => {
          clearTimeout(timer);
          this.pending.delete(id);
        };
      }

      this.pending.set(id, { id, at: this.now + ms, wait, run });

      return () => {
        this.pending.delete(id);
      };
    },
  };

  /** Whether a wait of one of these kinds is scheduled. */
  waiting = (...waits: ReadonlyArray<Wait>) =>
    [...this.pending.values()].some((each) => waits.includes(each.wait));

  /** The scheduled waits, soonest first (then in the order they were scheduled). */
  scheduled = () =>
    [...this.pending.values()]
      .sort((a, b) => a.at - b.at || a.id - b.id)
      .map((each) => ({
        at: each.at,
        wait: each.wait,
      }));

  /** Fires the soonest wait due by `until` (of the given kinds, if any); whether one fired. */
  fireNext = (until: number, waits?: ReadonlyArray<Wait>) => {
    const [next] = [...this.pending.values()]
      .filter((each) => each.at <= until && (!waits || waits.includes(each.wait)))
      .sort((a, b) => a.at - b.at || a.id - b.id);

    if (!next) return false;

    this.pending.delete(next.id);
    this.now = Math.max(this.now, next.at);
    next.run();

    return true;
  };
}
