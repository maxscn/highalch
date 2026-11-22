import type * as Aggregate from "@alchemy.run/domain/Aggregate";
import type { Step as AlchemyStep } from "@alchemy.run/domain/Story";
import { Option, Predicate } from "effect";
import { Mismatch, step, type Step, type Tagged, type World } from "@highalch/story/internal";
import { isDomainHost, type DomainHost } from "./host";

/** The story's host, as an alchemy Domain's: a step that needs one fails at once without one. */
const domainOf = (world: World): DomainHost => {
  if (!isDomainHost(world.host))
    throw new Mismatch(
      "this story's host hosts no alchemy Domain: Alchemy.given and Alchemy.remote need Alchemy.memory(…)",
    );

  return world.host;
};

/**
 * Seeds history: events committed on an aggregate before the story continues, as alchemy's
 * `Story.given(ref, ...events)` does (through the model's stores; they reach projections and so
 * the row feed, but no policy). Then the world settles. Needs a host that can seed (`memory`).
 */
export const given = <A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  ...events: ReadonlyArray<Aggregate.EventOf<A>>
): Step => {
  // SAFETY: an aggregate's events are tagged instances (alchemy's `Story.given` reads them so).
  const tagged = events as ReadonlyArray<Tagged>;

  return step(
    `given ${ref.aggregate}/${String(ref.id)}: ${tagged.map((event) => event._tag).join(", ")}`,
    async (world) => {
      await domainOf(world).seed(ref, tagged);
      await world.settle();
    },
  );
};

/**
 * Another client writes: a Domain command sent to an aggregate outside the story's clients, as
 * alchemy's `Story.when(ref, command)`. It must be accepted; then the world settles.
 */
export const remote = <A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  command: Aggregate.CommandOf<A> & Tagged,
): Step => {
  const sent: Tagged = command;

  return step(`remote ${ref.aggregate}/${String(ref.id)}: ${sent._tag}`, async (world) => {
    const failed = await domainOf(world).send(ref, sent, `story-remote:${world.next()}`);

    if (Option.isSome(failed))
      throw new Mismatch(`the remote ${sent._tag} failed: ${failed.value}`);

    await world.settle();
  });
};

/**
 * Alchemy's own story steps, run on the story's host (`Alchemy.from(Story.given(…))`):
 * `Story.given(ref, ...events)` seeds history (as `given`) and `Story.when(ref, command)` is
 * another client's write (as `remote`). Other
 * alchemy steps assert server decisions only: run them with alchemy's `Story.make`.
 */
export const from = (theirs: AlchemyStep): Step => {
  if (Predicate.isTagged(theirs, "Given") && "events" in theirs)
    return step(`given ${theirs.ref.aggregate}/${String(theirs.ref.id)}`, async (world) => {
      await domainOf(world).seed(theirs.ref, theirs.events);
      await world.settle();
    });

  if (Predicate.isTagged(theirs, "When") && "command" in theirs)
    return step(
      `remote ${theirs.ref.aggregate}/${String(theirs.ref.id)}: ${theirs.command._tag}`,
      async (world) => {
        const failed = await domainOf(world).send(
          theirs.ref,
          theirs.command,
          theirs.commandId ?? `story-remote:${world.next()}`,
        );

        if (Option.isSome(failed))
          throw new Mismatch(`the remote ${theirs.command._tag} failed: ${failed.value}`);

        await world.settle();
      },
    );

  throw new Error(
    `Alchemy.from(${theirs._tag}): only Story.given and Story.when run on a HighAlch story`,
  );
};
