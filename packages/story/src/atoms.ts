import { Option } from "effect";
import { AtomRegistry } from "effect/reactivity";
import type { Stage } from "./stage";
import type { Slot } from "./world";

type Held = Slot & { readonly registry: AtomRegistry.AtomRegistry };

const key: unique symbol = Symbol("@highalch/story/atoms");

const stages = new WeakMap<AtomRegistry.AtomRegistry, Stage>();

/**
 * The story's atom registry (`effect/reactivity`), made on first use and disposed when the story
 * ends: a screen mounts its component under it, and a machine step reads the actor a component
 * reads through its atoms from it, so both see one actor. Each story run has its own, so no
 * actor outlives its story.
 */
export const registryOf = (stage: Stage): AtomRegistry.AtomRegistry =>
  stage.slot<Held>(key, () => {
    const registry = AtomRegistry.make();

    stages.set(registry, stage);
    stage.end(async () => registry.dispose());

    return { registry };
  }).registry;

/** The story run a registry belongs to, if it is a story's. */
export const stageOf = (registry: AtomRegistry.AtomRegistry): Option.Option<Stage> =>
  Option.fromUndefinedOr(stages.get(registry));
