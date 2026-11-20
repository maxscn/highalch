import type * as Domain from "@alchemy.run/domain";
import { Cause, Option, Predicate } from "effect";
import { Clock } from "./clock";
import type { Host } from "./host";
import type { Answer } from "./values";
import { endpointsOf, Wire, type Endpoints } from "./wire";

/** A row as a story compares it: its fields, without TanStack DB's virtual `$` fields. */
export type Plain = Readonly<Record<string, Field>>;

/** A field of a row (any value, or nothing). */
export type Field = Answer | null | undefined;

/** A row as stable JSON (fields sorted, a `Map` as an object of its entries), for comparisons. */
export const json = <V>(value: V): string =>
  JSON.stringify(value, (_key, field: Field) => {
    if (field instanceof Map) return Object.fromEntries(field);

    if (Predicate.isObject(field) && !Array.isArray(field))
      return Object.fromEntries(Object.entries(field).sort(([a], [b]) => a.localeCompare(b)));

    return field;
  });

/** How a story's world runs. */
export type Options = {
  /** The clock the clients' timers wait on (default `manual`: only `advance` fires them). */
  readonly clock?: "manual" | "real";
};

/** Lets timers, I/O and the fibers they wake run once. */
export const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The hosted Domain of one story run: its host, the wire each scope's client talks to it through,
 * the clock the clients wait on, and when it is quiet. Adapters keep their own state (a scope's
 * client, a machine) and add what the world waits on (`waits`, `idles`). Nothing is global: a
 * story builds its own world and disposes it.
 */
export class World<A extends Domain.Api.Any = Domain.Api.Any> {
  /** The observation counter. */
  tick = 0;
  /** The step running now (from 1). */
  step = 0;
  /** The tick at which the world last settled. */
  settled = -1;
  readonly clock: Clock;
  private readonly wires = new Map<string, Wire>();
  private readonly raws = new Map<string, Promise<Endpoints>>();
  /** The Api's query names (a wire holds their answers; it lets command replies flow). */
  readonly queries: ReadonlySet<string>;
  /** Why the world is not quiet besides the host and the wires, added by adapters (feeds). */
  readonly waits: Array<() => Promise<Option.Option<string>>> = [];
  /** What `idle` waits for besides a quiet world, added by adapters (commands to end). */
  readonly idles: Array<() => Promise<void>> = [];
  /** What must hold for the world to be at rest besides being settled, added by adapters. */
  readonly rests: Array<() => boolean> = [];

  /** The scope steps act as now: the story's first scope, or the one an `as` step names. */
  scope: string;

  constructor(
    readonly host: Host<A>,
    readonly home: string,
    readonly options: Options,
  ) {
    this.scope = home;
    this.clock = new Clock(options.clock ?? "manual");

    this.queries = new Set(
      host.api.serves.flatMap((each) => {
        if (Predicate.hasProperty(each, "queryName") && Predicate.isString(each.queryName))
          return [each.queryName];

        return [];
      }),
    );
  }

  next = () => (this.tick += 1);

  /** The Api client a reader of `scope` uses, unwrapped: "another client". */
  raw = (scope: string) => {
    const known = this.raws.get(scope);

    if (known) return known;

    const made = this.host.client(scope).then(endpointsOf);

    this.raws.set(scope, made);

    return made;
  };

  /** The wire the client of `scope` talks to the Domain through (made on first use). */
  wire = (scope = this.scope): Wire => {
    const known = this.wires.get(scope);

    if (known) return known;

    const made = new Wire();

    this.wires.set(scope, made);

    return made;
  };

  /** Every wire made so far. */
  all = () => [...this.wires.values()];

  /** Why the world is not quiet now, or `None`. */
  busy = async (): Promise<Option.Option<string>> => {
    if (this.host.idle && !(await this.host.idle())) return Option.some("the server is busy");

    for (const [scope, wire] of this.wires)
      if (wire.inflight > 0) return Option.some(`${scope}: ${wire.inflight} request(s) in flight`);

    for (const wait of this.waits) {
      const reason = await wait();

      if (Option.isSome(reason)) return reason;
    }

    return Option.none();
  };

  /**
   * Waits until nothing more happens by itself: the server is idle, no request is in flight,
   * and nothing an adapter added waits (every live feed delivered the server's latest entry, no
   * retry is due on the real clock). Waits on the story's manual clock never fire
   * here: `advance` fires them. Command replies reach the clients only while the world settles;
   * `flow: false` waits without letting them through (the clients and their machines catch up,
   * the commands stay in flight).
   */
  settle = async (flow = true) => {
    let quiet = 0;
    let reason = Option.none<string>();
    const deadline = Date.now() + 3_000;

    if (flow) for (const wire of this.all()) wire.flow(true);

    while (quiet < 3 && Date.now() < deadline) {
      await macrotask();

      reason = await this.busy();

      if (Option.isNone(reason)) quiet += 1;
      else quiet = 0;
    }

    for (const wire of this.all()) wire.flow(false);

    if (quiet < 3)
      throw new Error(
        `The story did not settle: ${Option.getOrElse(reason, () => "it kept changing")}`,
      );

    this.settled = this.tick;
  };

  /**
   * Settles, then fires the manual clock's waits due within `ms` (in time order), settling after
   * each.
   */
  advance = async (ms: number) => {
    // What is in flight arrives first; then time passes.
    await this.settle();

    const until = this.clock.now + ms;

    while (this.clock.fireNext(until)) await this.settle();

    this.clock.now = until;
    await this.settle();
  };

  /**
   * At rest: settled since the last change, no wire held down or holding a reply (a command the
   * app sent, from a story step or its own code, has not been answered), and nothing an adapter
   * tracks in flight (every command ended).
   */
  rest = () =>
    this.settled === this.tick &&
    this.all().every((wire) => !wire.dropped && wire.held === 0) &&
    this.rests.every((check) => check());

  /**
   * Lets the story run its course: settles, then fires every timer on its clock, settling after
   * each, and lets every adapter's work end (`idles`).
   */
  exhaust = async () => {
    await this.settle();

    while (this.clock.fireNext(Number.POSITIVE_INFINITY)) await this.settle();

    for (const wait of this.idles) await wait();

    await this.settle();
  };

  /** Disposes the host (the adapters released their clients before). */
  dispose = async () => {
    await this.host.dispose();
  };
}

/** A defect as a readable line: an error carrying an Effect `Cause` shows the cause. */
export const describeDefect = <D>(defect: D) => {
  if (
    defect instanceof Error &&
    Predicate.hasProperty(defect, "cause") &&
    Cause.isCause(defect.cause)
  )
    return `${defect.name}: ${Cause.pretty(defect.cause)}`;

  return String(defect);
};
