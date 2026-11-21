import { Context, Effect, Layer, Option } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { CurrentStage, type Stage } from "./stage";

const stages = new WeakMap<AtomRegistry.AtomRegistry, Stage>();

/** The story's atom registry, as an adapter's service. */
export class Atoms extends Context.Service<Atoms, AtomRegistry.AtomRegistry>()(
  "@highalch/story/Atoms",
) {}

/**
 * The story's atom registry (`effect/reactivity`), made on first use and disposed when the story
 * ends: a screen mounts its component under it, and a machine step reads the actor a component
 * reads through its atoms from it, so both see one actor. Each story run has its own, so no
 * actor outlives its story.
 */
export const atoms = {
  service: Atoms,
  layer: Layer.effect(
    Atoms,
    Effect.gen(function* () {
      const stage = yield* CurrentStage;
      const registry = AtomRegistry.make();

      stages.set(registry, stage);
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

      return registry;
    }),
  ),
};

/** The story run's atom registry (made on first use). */
export const registryOf = (stage: Stage): Promise<AtomRegistry.AtomRegistry> => stage.use(atoms);

/** The story run a registry belongs to, if it is a story's. */
export const stageOf = (registry: AtomRegistry.AtomRegistry): Option.Option<Stage> =>
  Option.fromUndefinedOr(stages.get(registry));
