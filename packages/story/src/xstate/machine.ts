import { createEffectActor, type EffectActor } from "@xstate/effect";
import { Effect, Exit, Option, Predicate, Scope } from "effect";
import {
  initialTransition,
  transition,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type EventObject,
  type ExecutableActionObject,
  type MachineContext,
  type StateValue,
} from "xstate";
import type { TaggedFailure } from "@highalch/db";
import type { Answer, Input } from "@highalch/db/internal";
import { commandOf, Runner, type Invocable, type Marked } from "@highalch/db/xstate";
import { Mismatch, type Stage } from "../stage";
import { partial, staged, type Callable, type Step } from "../steps";
import { json, type Run, type Source, type World } from "../world";

/** A command a machine's transition spawned, with its actor id and input. */
type Spawned = {
  readonly command: Marked;
  readonly id: string;
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
 * A machine running against the story's client (`Machine.start`): its actor, the scope whose
 * client runs its commands, and the tick of the last event it was sent.
 */
type Running = {
  readonly mode: "running";
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
  readonly input: Answer | undefined;
};

const isSpawn = (action: ExecutableActionObject): action is ExecutableActionObject & Spawn =>
  action.type === "@xstate.spawn" &&
  Predicate.hasProperty(action, "logic") &&
  Predicate.hasProperty(action, "id") &&
  Predicate.isString(action.id);

const spawnedBy = (actions: ReadonlyArray<ExecutableActionObject>): ReadonlyArray<Spawned> =>
  actions.flatMap((action) => {
    if (!isSpawn(action)) return [];

    return Option.match(commandOf(action.logic), {
      onNone: () => [],
      onSome: (command) => [{ command, id: action.id, input: action.input }],
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

const where = (machine: Entered) => `${machine.name} (${machine.mode})`;

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

/**
 * The story's runner of a running machine's commands: on the client of the machine's scope,
 * recorded as the machine's (`asked` reads them; `settled`/`rejected` assert the last one).
 */
const runnerOf = (world: World, machine: () => Running) =>
  Runner.of({
    run: <I extends Input, A, E>(command: Invocable<I, A, E>, input: I) =>
      Effect.promise(() => {
        const running = machine();

        return world.start(
          `${running.name}: ${nameOf(running.machine, command)}`,
          running.scope,
          byOf(running.name),
          input,
          (client, onCommitted) => {
            if (!isCallable(command))
              throw new Error("invoke(command) takes a declared HighAlch command");

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
 * arrive by themselves, and `Story.settled`/`Story.rejected` assert them. Stopped when the story
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
        Effect.provideService(Runner, runnerOf(world, current)),
        Effect.provideService(Scope.Scope, scope),
      ),
    );

    const running: Running = {
      mode: "running",
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
    `${step} feeds a result to a machine stepped purely; ${machine.name} is running (Machine.start): its commands settle by themselves, so assert their outcome with Story.settled(...) or Story.rejected(...)`,
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
        type: `xstate.done.actor.${spawned.id}`,
        output: value,
        actorId: spawned.id,
      }),
      onNone: () => ({
        type: `xstate.error.actor.${spawned.id}`,
        error: value,
        actorId: spawned.id,
      }),
    },
  );

  return stepped(machine, event);
};

/**
 * Stepped only: the command the machine asked for last settled with this output (its `Settled`
 * value); the machine takes `xstate.done.actor.*`.
 */
const done = (command: Marked, output?: Answer, options: Addressed = {}): Step =>
  staged(`${prefix(options)}command done`, async (stage) => {
    const machine = steppedOnly(find(stage, options), "Machine.done");

    store(stage, answer(machine, command, "done", output));
  });

/**
 * Stepped only: the command the machine asked for last failed with this typed error; the machine
 * takes `xstate.error.actor.*`.
 */
const failed = (command: Marked, error: TaggedFailure, options: Addressed = {}): Step =>
  staged(`${prefix(options)}command failed with ${error._tag}`, async (stage) => {
    const machine = steppedOnly(find(stage, options), "Machine.failed");

    store(stage, answer(machine, command, "error", error));
  });

/**
 * Machine steps, run by the one story runner beside data steps, in any order. A machine enters a
 * story one of two ways, chosen once: `given` (stepped purely, works hostless) or `start` (running
 * against the story's client, needs a host). `when`, `then`, `asked` and `askedNothing` mean the
 * same in both; `done`/`failed` feed results to a stepped machine only. Each takes an optional
 * `{ machine }` naming the machine (default: the one introduced last); `given`/`start` take
 * `{ name }` (default: the machine's `id`).
 */
export const Machine = {
  given,
  start,
  when,
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is the given/when/then vocabulary
  then,
  asked,
  askedNothing,
  done,
  failed,
} as const;
