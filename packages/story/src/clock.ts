import { Clock as EffectClock, Duration, Effect } from "effect";
import { waitKind, type Wait } from "@lowalch/tanstack-db/internal";

const live = Effect.runSync(EffectClock.Clock);

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

  private timeMillis = () => {
    if (this.mode === "real") return live.currentTimeMillisUnsafe();

    return this.now;
  };

  private timeNanos = () => BigInt(this.timeMillis()) * 1_000_000n;

  readonly service: EffectClock.Clock = {
    currentTimeMillisUnsafe: this.timeMillis,
    currentTimeMillis: Effect.sync(this.timeMillis),
    currentTimeNanosUnsafe: this.timeNanos,
    currentTimeNanos: Effect.sync(this.timeNanos),
    monotonicTimeNanosUnsafe: () => {
      if (this.mode === "real") return live.monotonicTimeNanosUnsafe();

      return this.timeNanos();
    },
    monotonicTimeNanos: Effect.suspend(() => {
      if (this.mode === "real") return live.monotonicTimeNanos;

      return Effect.sync(this.timeNanos);
    }),
    sleep: (duration) =>
      Effect.flatMap(waitKind, (wait) =>
        Effect.callback<void>((resume) =>
          Effect.sync(this.set(() => resume(Effect.void), Duration.toMillis(duration), wait)),
        ),
      ),
  };

  private set(run: () => void, ms: number, wait: Wait) {
    const id = (this.sequence += 1);

    this.pending.set(id, { id, at: this.now + ms, wait, run });

    if (this.mode === "real") {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        run();
      }, ms);

      return () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
    }

    return () => {
      this.pending.delete(id);
    };
  }

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
