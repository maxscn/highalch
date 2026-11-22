import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * An alchemy binding call, inside a service the domain declares without requirements (`Storage`,
 * `Payments`, `Sessions`, …). Every alchemy platform provides `RuntimeContext` to what it runs:
 * a Worker request, a Durable Object event (where policies call external systems). The domain's
 * service types cannot say so, so this is the one place that states it.
 */
export const ambient = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  // SAFETY: RuntimeContext is provided by the host on every request and Durable Object event.
  effect as unknown as Effect.Effect<A, E, Exclude<R, RuntimeContext>>;
