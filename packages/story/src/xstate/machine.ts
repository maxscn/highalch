import { createEffectActor, EffectFailure, type EffectActor } from "@xstate/effect";
import { Cause, Effect, Exit, Layer, Option, Predicate, Scope } from "effect";
import { Atom, AtomRegistry, type AsyncResult } from "effect/reactivity";
import {
  initialTransition,
  transition,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type EventObject,
  type ExecutableEffect,
  type MachineContext,
  type StateValue,
} from "xstate";
import type { TaggedFailure } from "@lowalch/tanstack-db";
import type { Answer, Input } from "@lowalch/tanstack-db/internal";
import { commandOf, Runner, type Invocable, type Marked } from "@lowalch/tanstack-db/xstate";
import { registryOf, stageOf } from "../atoms";
import { Mismatch, type Stage } from "../stage";
import { partial, staged, type Callable, type Step } from "../steps";
import { json, type Run, type Source, type World } from "../world";

/** A command a machine's transition spawned, with its actor id, session and input. */
type Spawned = {
  readonly command: Marked;
  readonly id: string;
  /** The spawned actor's session, which its done and error events name. */
  readonly session: string;
  readonly input: Answer | undefined;
};

/**
 * A machine stepped purely (`Machine.given`): its snapshot, and what its transitions asked for.
 * Every step is XState's pure `transition`; nothing runs.
 */
type Stepped = {
  readonly mode: "stepped";
  readonly name: string;
  readonly machine: AnyStateMachine;
  readonly snapshot: AnyMachineSnapshot;
  /** The commands the last transition spawned. */
  readonly asked: ReadonlyArray<Spawned>;
  /** Every command spawned so far, latest last (`done`/`failed` answer the latest one). */
  readonly invoked: ReadonlyArray<Spawned>;
};

/**
 * A machine running against the story's client: its actor, the scope whose client runs its
 * commands, and the tick of the last event it was sent. The story made the actor
 * (`Machine.start`), or it is the one a mounted component reads through its atoms
 * (`Machine.mounted`).
 */
type Running = {
  readonly mode: "running";
  /** Whether the actor is the story registry's (`Machine.mounted`), not one the story made. */
  readonly mounted: boolean;
  readonly name: string;
  readonly machine: AnyStateMachine;
  readonly actor: EffectActor<AnyStateMachine>;
  readonly scope: string;
  since: number;
};

type Entered = Stepped | Running;

/** The machines of one story run, by name, and the one introduced last. */
type Machines = { readonly entered: Map<string, Entered>; latest: Option.Option<string> };

const machinesKey: unique symbol = Symbol("@highalch/story/xstate/machines");

const machinesOf = (stage: Stage) =>
  stage.slot<Machines>(machinesKey, () => ({ entered: new Map(), latest: Option.none() }));

/** Which machine a step addresses: the one of this name, else the one introduced last. */
export type Addressed = { readonly machine?: string };

/** How a machine is named when it enters a story (default: its `id`). */
export type Named = { readonly name?: string };

/** What a snapshot is expected to be: a state value it matches and, optionally, context fields. */
export type Expected = { readonly state: StateValue; readonly context?: MachineContext };

/**
 * Reads what a source shows now in the step's client (or the client of `as`), opened and settled
 * first if it was not observed yet: its rows by key, without TanStack DB's virtual fields. It needs
 * a hosted story.
 */
export type Read = <Row extends object>(
  source: Source<Row>,
  options?: { readonly as?: string },
) => Promise<ReadonlyArray<Row>>;

/** A value given as is, or computed from what the story's sources show when the step runs. */
export type FromShown<T> = T | ((read: Read) => T | Promise<T>);

const readerOf =
  (stage: Stage, label: string): Read =>
  async <Row extends object>(source: Source<Row>, options: { readonly as?: string } = {}) => {
    const world = stage.hosted(label);
    const { observed, opened } = await world.observe(source, options.as);

    if (opened) await world.settle();

    // SAFETY: an observed source's rows are its `Row`s, without TanStack DB's virtual fields.
    return observed.sorted().map(([, shown]) => shown.row as Row);
  };

const resolved = async <T extends object>(
  value: FromShown<T>,
  stage: Stage,
  label: string,
): Promise<T> => {
  if (Predicate.isFunction(value)) return value(readerOf(stage, label));

  return value;
};

/** The name a machine's `setup({ actors })` registers this command's logic under, if any. */
const sourceOf = (machine: AnyStateMachine, command: Marked) =>
  Option.fromUndefinedOr(
    Object.entries(machine.sources.actors ?? {}).find(([, logic]) =>
      Option.contains(commandOf(logic), command),
    )?.[0],
  );

const nameOf = (machine: AnyStateMachine, command: Marked) =>
  Option.getOrElse(sourceOf(machine, command), () => "a command");

/** A spawn action as XState's pure `transition` returns it: the logic, the actor id, the input. */
type Spawn = {
  readonly logic: AnyActorLogic;
  readonly id: string;
  readonly actor: { readonly sessionId: string };
  readonly input: Answer | undefined;
};

const isSpawn = (action: ExecutableEffect): action is ExecutableEffect & Spawn =>
  action.type === "@xstate.spawn" &&
  Predicate.hasProperty(action, "logic") &&
  Predicate.hasProperty(action, "id") &&
  Predicate.isString(action.id) &&
  Predicate.hasProperty(action, "actor");

const spawnedBy = (actions: ReadonlyArray<ExecutableEffect>): ReadonlyArray<Spawned> =>
  actions.flatMap((action) => {
    if (!isSpawn(action)) return [];

    return Option.match(commandOf(action.logic), {
      onNone: () => [],
      onSome: (command) => [
        { command, id: action.id, session: action.actor.sessionId, input: action.input },
      ],
    });
  });

const stepped = (machine: Stepped, event: EventObject): Stepped => {
  const [snapshot, actions] = transition(machine.machine, machine.snapshot, event);
  const asked = spawnedBy(actions);

  return { ...machine, snapshot, asked, invoked: [...machine.invoked, ...asked] };
};

/** A command a machine asked for, as a step compares and reports it. */
type Ask = { readonly command: Marked; readonly input: Answer | undefined };

const snapshotOf = (machine: Entered) => {
  if (machine.mode === "stepped") return machine.snapshot;

  return machine.actor.getSnapshot();
};

/** The commands asked for since the last event: spawned (stepped) or run on the client (running). */
const askedOf = (stage: Stage, machine: Entered, label: string): ReadonlyArray<Ask> => {
  if (machine.mode === "stepped") return machine.asked;

  return stage
    .hosted(label)
    .runs.filter((run) => run.by === byOf(machine.name) && run.tick > machine.since)
    .flatMap((run) =>
      Option.match(run.command, {
        onNone: () => [],
        onSome: (command) => [{ command, input: run.input }],
      }),
    );
};

const where = (machine: Entered) => {
  if (machine.mode === "running" && machine.mounted) return `${machine.name} (mounted)`;

  return `${machine.name} (${machine.mode})`;
};

const describe = (snapshot: AnyMachineSnapshot) =>
  `${json(snapshot.value)} ${json(snapshot.context)}`;

const listed = (machine: Entered, asked: ReadonlyArray<Ask>) => {
  if (asked.length === 0) return "nothing";

  return asked
    .map((each) => `${nameOf(machine.machine, each.command)} ${json(each.input)}`)
    .join(", ");
};

/** What every machine failure lists: where the machine is and what it asked for. */
const context = (stage: Stage, machine: Entered, label: string) => [
  `machine ${where(machine)} is ${describe(snapshotOf(machine))}`,
  `asked since its last event: ${listed(machine, askedOf(stage, machine, label))}`,
];

const byOf = (name: string) => `machine:${name}`;

/** The machine a step addresses: named, or the one introduced last. */
const find = (stage: Stage, options: Addressed): Entered => {
  const machines = machinesOf(stage);

  const name = Option.orElse(Option.fromUndefinedOr(options.machine), () => machines.latest);

  if (Option.isNone(name))
    throw new Mismatch(
      "no machine in the story yet: bring one in with Machine.given(machine, snapshot) to step it purely, or Machine.start(machine, { input }) to run it",
    );

  const found = machines.entered.get(name.value);

  if (!found)
    throw new Mismatch(`the story has no machine named "${name.value}"`, [
      `machines: ${[...machines.entered.keys()].join(", ") || "none"}`,
    ]);

  return found;
};

const enter = (stage: Stage, machine: Entered) => {
  const machines = machinesOf(stage);

  if (machines.entered.has(machine.name))
    throw new Mismatch(
      `the story already has a machine named "${machine.name}": name this one ({ name })`,
    );

  machines.entered.set(machine.name, machine);
  machines.latest = Option.some(machine.name);
};

/** Replaces a stepped machine's state after a pure step. */
const store = (stage: Stage, machine: Stepped) => {
  machinesOf(stage).entered.set(machine.name, machine);
};

const prefix = (options: Addressed) =>
  Option.match(Option.fromUndefinedOr(options.machine), {
    onNone: () => "",
    onSome: (name) => `${name}: `,
  });

const isCallable = <I extends Input, A, E>(
  command: Invocable<I, A, E>,
): command is Invocable<I, A, E> & Callable<I> =>
  Predicate.hasProperty(command, "with") && Predicate.isFunction(command.with);

/** Who a command is run for: the name it is recorded under, how it reads, and the client's scope. */
type Owner = { readonly name: string; readonly label: string; readonly scope: string };

/**
 * The story's runner of a running machine's commands: on the client of the owner's scope,
 * recorded as the owner's (`asked` reads them; `settled`/`rejected` assert the last one).
 */
const runnerOf = (
  world: World,
  owner: <I extends Input, A, E>(command: Invocable<I, A, E>, input: I) => Owner,
) =>
  Runner.of({
    run: <I extends Input, A, E>(command: Invocable<I, A, E>, input: I) =>
      Effect.promise(() => {
        const { name, label, scope } = owner(command, input);

        return world.start(
          label,
          scope,
          byOf(name),
          input,
          (client, onCommitted) => {
            if (!isCallable(command))
              throw new Error("invoke(command) takes a declared LowAlch command");

            return command.with({ client })(input, { onCommitted });
          },
          Option.some(command),
        );
      }).pipe(
        Effect.flatMap((run: Run) => Effect.promise(() => run.done.then(() => run.outcome))),
        Effect.flatMap((outcome): Effect.Effect<A, E> => {
          if (Predicate.isTagged(outcome, "Rejected") && "error" in outcome)
            // SAFETY: the command's typed rejection is one of its declared errors.
            return Effect.fail(outcome.error as E);

          if (Predicate.isTagged(outcome, "Died") && "cause" in outcome)
            return Effect.failCause(outcome.cause);

          const value = Option.flatten(
            Option.liftPredicate(
              Predicate.hasProperty(outcome, "value") ? outcome.value : Option.none(),
              Option.isOption,
            ),
          );

          // SAFETY: a settled command's value is its `Settled` value, the invoked actor's output.
          return Effect.succeed(Option.getOrUndefined(value) as A);
        }),
      ),
  });

const ownerOf = (running: Running, command: Marked): Owner => ({
  name: running.name,
  label: `${running.name}: ${nameOf(running.machine, command)}`,
  scope: running.scope,
});

/** The name commands run under when no mounted machine of the story is seen to invoke them. */
const unnamed = "mounted";

/** Whether an actor has a child that was given exactly this input (the command it invokes now). */
const invokes = (running: Running, input: unknown) =>
  Object.values(running.actor.getSnapshot().children ?? {}).some((child) => {
    const snapshot: unknown = Predicate.hasProperty(child, "getSnapshot")
      ? Reflect.apply(child.getSnapshot as () => unknown, child, [])
      : undefined;

    return Predicate.hasProperty(snapshot, "input") && snapshot.input === input;
  });

/**
 * The mounted machine a command of the story's registry is run for: the one whose actor invokes
 * a child with this very input; else the only mounted machine that registers the command.
 * A command of an actor the story never introduced (`Machine.mounted`) is recorded as `mounted`.
 */
const mountedOwner = (stage: Stage, world: World, command: Marked, input: unknown): Owner => {
  const candidates = [...machinesOf(stage).entered.values()].filter(
    (each): each is Running => each.mode === "running" && each.mounted,
  );

  const registering = candidates.filter((each) => Option.isSome(sourceOf(each.machine, command)));

  const found = Option.orElse(
    Option.fromUndefinedOr(candidates.find((each) => invokes(each, input))),
    () => Option.liftPredicate(registering[0], () => registering.length === 1),
  );

  return Option.match(Option.flatMap(found, Option.fromUndefinedOr), {
    onNone: () => ({ name: unnamed, label: `${unnamed}: a command`, scope: world.scope }),
    onSome: (running) => ownerOf(running, command),
  });
};

/**
 * In a story's registry, every atom runtime runs its machines' commands on the story's client,
 * recorded: a layer of `Atom.runtime` that provides the `Runner`. In any other registry (an
 * application's) it runs the command as `invoke` does without a runner. Added once, when this
 * entry is loaded, so a component mounted before any machine step is covered too.
 */
Atom.runtime.addGlobalLayer(
  Layer.effect(
    Runner,
    Effect.map(Effect.service(AtomRegistry.AtomRegistry), (registry) =>
      Runner.of({
        run: (command, input) =>
          Option.match(stageOf(registry), {
            onNone: () => command.effect(input),
            onSome: (stage) => {
              const world = stage.hosted("a mounted machine's command");

              return runnerOf(world, (asked, given) =>
                mountedOwner(stage, world, asked, given),
              ).run(command, input);
            },
          }),
      }),
    ),
  ),
);

/** A snapshot a stepped machine starts from: a state value and context, or the machine's input. */
export type Snapshot = {
  readonly state?: StateValue;
  readonly context?: MachineContext;
  readonly input?: Input;
};

/**
 * The machine enters the story **stepped purely**: from this snapshot (its initial state and
 * context when omitted, for `input`), every later step is XState's pure `transition`. Nothing
 * runs: `asked` reads the commands a transition would spawn, and `done`/`failed` feed it their
 * results. Works in a hostless story; in a hosted one the snapshot can be computed from what the
 * sources show (`(read) => snapshot`), and the data steps around it run as usual.
 */
const given = (
  machine: AnyStateMachine,
  snapshot: FromShown<Snapshot> = {},
  options: Named = {},
): Step => {
  const name = options.name ?? machine.id;
  const label = `given ${name} stepped purely`;

  return staged(label, async (stage) => {
    const from = await resolved(snapshot, stage, label);
    const [initial] = initialTransition(machine, from.input);

    const start = Option.match(Option.fromUndefinedOr(from.state), {
      onNone: () => initial,
      onSome: (value) => machine.resolveState({ value, context: from.context ?? initial.context }),
    });

    enter(stage, { mode: "stepped", name, machine, snapshot: start, asked: [], invoked: [] });
  });
};

/**
 * The machine enters the story **running**: started with `createEffectActor` against the story's
 * client (of the step's scope, so `as(scope, Machine.start(...))` runs it on that client). The
 * commands it invokes through `invoke(command)` run there and are recorded; their real outcomes
 * arrive by themselves, and `Db.settled`/`Db.rejected` assert them. Stopped when the story
 * ends. Needs a hosted story.
 */
const start = (
  machine: AnyStateMachine,
  options: Named & { readonly input?: Input } = {},
): Step => {
  const name = options.name ?? machine.id;
  const label = `start ${name} running`;

  return staged(label, async (stage) => {
    const world = stage.hosted(label);

    await world.connect();

    const scope = Effect.runSync(Scope.make());
    let entered = Option.none<Running>();

    const current = () =>
      Option.getOrThrowWith(entered, () => new Error(`${name} invoked a command while starting`));

    // SAFETY: a machine whose commands are `invoke` logic requires no services but the runner.
    const create = createEffectActor(machine, { input: options.input }) as Effect.Effect<
      EffectActor<AnyStateMachine>,
      never,
      Runner | Scope.Scope
    >;

    const actor = Effect.runSync(
      create.pipe(
        Effect.provideService(
          Runner,
          runnerOf(world, (command) => ownerOf(current(), command)),
        ),
        Effect.provideService(Scope.Scope, scope),
      ),
    );

    const running: Running = {
      mode: "running",
      mounted: false,
      name,
      machine,
      actor,
      scope: world.scope,
      since: world.next(),
    };

    entered = Option.some(running);
    enter(stage, running);
    world.releases.push(() => {
      actor.stop();
      Effect.runFork(Scope.close(scope, Exit.void));
    });
    await world.settle(false);
  });
};

/** The atoms of an actor, as `createActorAtoms` gives them: the story reads `actor`. */
export type Atoms<M extends AnyStateMachine = AnyStateMachine> = {
  readonly actor: Atom.Atom<AsyncResult.AsyncResult<EffectActor<M>, unknown>>;
};

/**
 * The machine enters the story **running, as a mounted component reads it**: the actor the
 * story's registry holds for these atoms (`createActorAtoms` from `@xstate/effect/atom`), which
 * is the one a component under `Screen.render` reads through the same atoms. Before or after the
 * render: the story keeps the actor alive until it ends. Its commands run on the story's client
 * (of the step's scope) and are recorded, as a started machine's are. Needs a hosted story.
 */
const mounted = <M extends AnyStateMachine>(atoms: Atoms<M>, options: Named = {}): Step => {
  const label = `enter ${options.name ?? "a machine"} as mounted`;

  return staged(label, async (stage) => {
    const world = stage.hosted(label);

    await world.connect();

    const registry = registryOf(stage);
    const release = registry.mount(atoms.actor);

    stage.end(async () => release());

    const actor = await Effect.runPromise(
      AtomRegistry.getResult(registry, atoms.actor, { suspendOnWaiting: true }),
    ).catch((error: unknown) => {
      throw new Mismatch("the atoms' actor did not start: its runtime failed to build", [
        String(error),
      ]);
    });

    enter(stage, {
      mode: "running",
      mounted: true,
      name: options.name ?? actor.logic.id,
      machine: actor.logic,
      actor,
      scope: world.scope,
      since: world.next(),
    });
    await world.settle(false);
  });
};

/**
 * The machine receives an event (or one computed from what the sources show: `(read) => event`).
 * Stepped: its next snapshot and the commands it would ask for; nothing runs. Running: sent to
 * the actor, which reacts and starts the commands it asks for on the story's client; their replies
 * wait, as after a data `when`, until a settling step.
 */
const when = <E extends EventObject>(event: FromShown<E>, options: Addressed = {}): Step => {
  const label = Option.match(
    Option.liftPredicate(event, (value): value is E => !Predicate.isFunction(value)),
    {
      onNone: () => `${prefix(options)}send an event from what is shown`,
      onSome: (given) => `${prefix(options)}send ${given.type}`,
    },
  );

  return staged(label, async (stage) => {
    const machine = find(stage, options);
    const sent = await resolved(event, stage, label);

    if (machine.mode === "stepped") return store(stage, stepped(machine, sent));

    const world = stage.hosted(label);

    machine.since = world.next();
    machine.actor.send(sent);
    await world.settle(false);
  });
};

/** The machine is in this state (`snapshot.matches(state)`), with these context fields. */
const then = (expected: Expected, options: Addressed = {}): Step => {
  const label = `${prefix(options)}machine is ${json(expected.state)}`;

  return staged(label, async (stage) => {
    const machine = find(stage, options);
    const snapshot = snapshotOf(machine);

    if (snapshot.matches(expected.state) && partial(expected.context ?? {}, snapshot.context))
      return;

    throw new Mismatch(`${where(machine)} is not in the expected state`, [
      `expected ${json(expected.state)} ${json(expected.context ?? {})}`,
      `observed ${describe(snapshot)}`,
      `asked since its last event: ${listed(machine, askedOf(stage, machine, label))}`,
    ]);
  });
};

/**
 * The machine asked for this command (with input fields like these) since its last event.
 * Stepped: the spawn actions of `invoke(command)` logic its last transition returned. Running:
 * the commands the story's `Runner` ran for it.
 */
const asked = <I extends object>(
  command: Invocable<I, unknown, unknown>,
  input?: Partial<I>,
  options: Addressed = {},
): Step => {
  const label = `${prefix(options)}asked ${Option.match(Option.fromUndefinedOr(input), {
    onNone: () => "a command",
    onSome: (fields) => json(fields),
  })}`;

  return staged(label, async (stage) => {
    const machine = find(stage, options);
    const all = askedOf(stage, machine, label);

    const holds = all.some(
      (each) => each.command === command && (input === undefined || partial(input, each.input)),
    );

    if (holds) return;

    throw new Mismatch(
      `${where(machine)} did not ask for ${nameOf(machine.machine, command)}${input ? " with that input" : ""}`,
      [
        `expected ${nameOf(machine.machine, command)} ${input ? json(input) : "(any input)"}`,
        `observed ${listed(machine, all)}`,
        `machine ${where(machine)} is ${describe(snapshotOf(machine))}`,
      ],
    );
  });
};

/** The machine asked for no command since its last event. */
const askedNothing = (options: Addressed = {}): Step => {
  const label = `${prefix(options)}asked nothing`;

  return staged(label, async (stage) => {
    const machine = find(stage, options);
    const all = askedOf(stage, machine, label);

    if (all.length === 0) return;

    throw new Mismatch(`${where(machine)} asked for commands`, context(stage, machine, label));
  });
};

/** A stepped machine; a running one is a clear error (its commands settle by themselves). */
const steppedOnly = (machine: Entered, step: string): Stepped => {
  if (machine.mode === "stepped") return machine;

  throw new Mismatch(
    `${step} feeds a result to a machine stepped purely; ${machine.name} is running (Machine.start): its commands settle by themselves, so assert their outcome with Db.settled(...) or Db.rejected(...)`,
  );
};

const answer = (
  machine: Stepped,
  command: Marked,
  outcome: "done" | "error",
  value: Answer | TaggedFailure | undefined,
) => {
  const spawned = [...machine.invoked].reverse().find((each) => each.command === command);

  if (!spawned)
    throw new Mismatch(`${where(machine)} never asked for ${nameOf(machine.machine, command)}`, [
      `asked so far: ${listed(machine, machine.invoked)}`,
    ]);

  const event = Option.match(
    Option.liftPredicate(outcome, (tag) => tag === "done"),
    {
      onSome: () => ({
        type: "xstate.done.actor",
        output: value,
        actorId: spawned.id,
        sessionId: spawned.session,
      }),
      // As a running command fails: the typed error inside an `EffectFailure`.
      onNone: () => ({
        type: "xstate.error.actor",
        error: new EffectFailure(Cause.fail(value)),
        actorId: spawned.id,
        sessionId: spawned.session,
      }),
    },
  );

  return stepped(machine, event);
};

/**
 * Stepped only: the command the machine asked for last settled with this output (its `Settled`
 * value); the machine takes `xstate.done.actor`.
 */
const done = (command: Marked, output?: Answer, options: Addressed = {}): Step =>
  staged(`${prefix(options)}command done`, async (stage) => {
    const machine = steppedOnly(find(stage, options), "Machine.done");

    store(stage, answer(machine, command, "done", output));
  });

/**
 * Stepped only: the command the machine asked for last failed with this typed error; the machine
 * takes `xstate.error.actor` with the error inside an `EffectFailure`, as a running command fails.
 */
const failed = (command: Marked, error: TaggedFailure, options: Addressed = {}): Step =>
  staged(`${prefix(options)}command failed with ${error._tag}`, async (stage) => {
    const machine = steppedOnly(find(stage, options), "Machine.failed");

    store(stage, answer(machine, command, "error", error));
  });

/**
 * Machine steps, run by the one story runner beside data steps, in any order. A machine enters a
 * story one of three ways, chosen once: `given` (stepped purely, works hostless), `start`
 * (running against the story's client, needs a host) or `mounted` (running, the actor a mounted
 * component reads through its atoms). `when`, `then`, `asked` and `askedNothing` mean the
 * same in both; `done`/`failed` feed results to a stepped machine only. Each takes an optional
 * `{ machine }` naming the machine (default: the one introduced last); `given`/`start`/`mounted` take
 * `{ name }` (default: the machine's `id`).
 */
export const Machine = {
  given,
  start,
  mounted,
  when,
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is the given/when/then vocabulary
  then,
  asked,
  askedNothing,
  done,
  failed,
} as const;
