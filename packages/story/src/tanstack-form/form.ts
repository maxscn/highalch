import type { AnyFormApi, AnyFormState } from "@tanstack/react-form";
import { Effect, Option, Predicate, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import type { AnySource } from "../sources";
import { reader, type Reader } from "../rules";
import { Mismatch, type Stage } from "../stage";
import { partial, staged, type Step } from "../steps";
import { json, macrotask } from "../world";
import { forms } from "./registry";

/**
 * A form as the app declares it: its own `formOptions({...})` object, which components spread into
 * stock `useForm`. A mounted form is this one when every option it declares (but its default
 * values, which components often set per instance) is the very same in the mounted form's options.
 */
export type Declared = object & { readonly defaultValues?: unknown; readonly formId?: string };

/** The values of a declared form. */
type ValuesOf<F> = F extends { readonly defaultValues?: infer D } ? NonNullable<D> : never;

/** The fields of a declared form (its top-level values). */
export type FieldOf<F> = keyof ValuesOf<F> & string;

/** One mounted instance of a form, as a step addresses it: by a predicate over its values. */
export type Where<F extends Declared> = {
  readonly form: F;
  readonly where: (values: ValuesOf<F>) => boolean;
  readonly description: string;
};

/** A form a step addresses: the declared form (one instance mounted), or `Form.where(form, …)`. */
export type Target<F extends Declared> = F | Where<F>;

const isWhere = <F extends Declared>(target: Target<F>): target is Where<F> =>
  Predicate.hasProperty(target, "where") && Predicate.isFunction(target.where);

const formOf = <F extends Declared>(target: Target<F>): F => {
  if (isWhere(target)) return target.form;

  return target;
};

/** How a step names a form: its `formId`, or `form`. */
const nameOf = (form: Declared) => form.formId ?? "form";

const shared = new Set(["defaultValues", "defaultState"]);

/** Whether a mounted form is an instance of a declared one. */
export const isInstance = (api: AnyFormApi, form: Declared) => {
  const keys = Object.keys(form).filter((key) => !shared.has(key));

  if (keys.length === 0)
    return Reflect.get(api.options, "defaultValues") === Reflect.get(form, "defaultValues");

  return keys.every((key) => Reflect.get(api.options, key) === Reflect.get(form, key));
};

/** Every mounted instance of a declared form, in mount order. */
export const instancesOf = (form: Declared) => forms().filter((api) => isInstance(api, form));

/** An instance as a failure describes it: `renameForm #2 (title: "Ada")`. */
const describe = (form: Declared, api: AnyFormApi, index: number) => {
  const values: Readonly<Record<string, unknown>> = api.state.values;
  const shown = Object.entries(values)
    .map(([field, value]) => `${field}: ${json(value)}`)
    .join(", ");

  return `${nameOf(form)} #${index + 1} (${shown})`;
};

/**
 * The one mounted instance a step addresses: the declared form's only instance, or the only one
 * `Form.where` picks. None or several fail the step, listing what is mounted; it never guesses.
 */
const instanceOf = <F extends Declared>(target: Target<F>): AnyFormApi => {
  const form = formOf(target);
  const all = instancesOf(form);

  const picked = all.filter(
    (api) => !isWhere(target) || target.where(api.state.values as ValuesOf<F>),
  );

  const [only] = picked;

  if (picked.length === 1 && only) return only;

  const mounted = all.map((api, index) => describe(form, api, index));

  const what = Option.match(
    Option.liftPredicate(target, (each): each is Where<F> => isWhere(each)),
    {
      onNone: () => nameOf(form),
      onSome: (where) => `${nameOf(form)} where ${where.description}`,
    },
  );

  const reason = Option.match(
    Option.liftPredicate(picked.length, (count) => count === 0),
    {
      onSome: () => `no mounted ${what}`,
      onNone: () =>
        `${picked.length} mounted instances of ${what}: pick one with Form.where(form, (values) => …)`,
    },
  );

  const others = Option.match(
    Option.liftPredicate(forms().length, (count) => count > 0 && all.length === 0),
    {
      onNone: () => [],
      onSome: () => [
        "mounted forms of other options exist: is this the formOptions object the component spreads?",
      ],
    },
  );

  throw new Mismatch(reason, [`mounted: ${mounted.join("; ") || "none"}`, ...others]);
};

/** Lets React and the world catch up after a change to a form, without letting replies through. */
const settled = async (stage: Stage) => {
  await macrotask();

  await Option.match(stage.world, {
    onNone: async () => {},
    onSome: (world) => world.settle(false),
  });
};

/** One instance of a form, picked by its values: `Form.where(renameForm, (v) => v.NoteId === "n1")`. */
export const where = <F extends Declared>(
  form: F,
  predicate: (values: ValuesOf<F>) => boolean,
): Where<F> => ({
  form,
  where: predicate,
  description: predicate.toString().replaceAll(/\s+/g, " ").slice(0, 60),
});

/**
 * The user types into a field: `Form.when(renameForm, "title", "Ada 2")`. Sets the field's value on
 * the mounted form (its `onChange` validators run), then lets React and the world catch up.
 */
export const when = <F extends Declared, K extends FieldOf<F>>(
  target: Target<F>,
  field: K,
  value: ValuesOf<F>[K],
): Step =>
  staged(`${nameOf(formOf(target))}: set ${field} to ${json(value)}`, async (stage) => {
    const api = instanceOf(target);

    api.setFieldValue(field, value);
    await settled(stage);
  });

/**
 * The user submits the form: `Form.submit(renameForm)`. Its `onSubmit` runs; a command it starts
 * waits for its reply as a data `when` does, until a settling step.
 */
export const submit = <F extends Declared>(target: Target<F>): Step =>
  staged(`${nameOf(formOf(target))}: submit`, async (stage) => {
    const api = instanceOf(target);

    void api.handleSubmit();
    await settled(stage);
  });

/** What `Form.then` expects of a form's state, each field compared partially. */
export type Expected<F extends Declared> = {
  readonly values?: Partial<ValuesOf<F>>;
  readonly errors?: ReadonlyArray<unknown>;
  readonly canSubmit?: boolean;
  readonly isSubmitting?: boolean;
  readonly isDirty?: boolean;
};

/**
 * `Form.then`: the form's state is as expected (`Form.then(renameForm, { values: { title: "Ada" } })`).
 * Not exported as `then`: a module whose exports include `then` is a thenable to `import()`.
 */
export const thenIs = <F extends Declared>(target: Target<F>, expected: Expected<F>): Step =>
  staged(`${nameOf(formOf(target))}: then ${json(expected)}`, async () => {
    const api = instanceOf(target);
    const state: AnyFormState = api.state;

    if (partial(expected, state)) return;

    const shown = Object.fromEntries(
      Object.keys(expected).map((key) => [key, Reflect.get(state, key)]),
    );

    throw new Mismatch(`${nameOf(formOf(target))} is not in the expected state`, [
      `expected ${json(expected)}`,
      `observed ${json(shown)}`,
    ]);
  });

/** The state of the one instance a target addresses, as a rule reads it (`undefined`: none). */
export const state = <F extends Declared>(target: Target<F>): Reader<AnyFormState | undefined> =>
  reader(`form ${nameOf(formOf(target))}`, async () => {
    const all = instancesOf(formOf(target));

    if (all.length === 0) return undefined;

    return instanceOf(target).state;
  });

/** The states of every mounted instance of a form, in mount order, as a rule reads them. */
export const all = <F extends Declared>(form: F): Reader<ReadonlyArray<AnyFormState>> =>
  reader(`forms ${nameOf(form)}`, async () => instancesOf(form).map((api) => api.state));

/** The validator a declared form's values decode with, when it is an Effect Schema struct. */
const schemaOf = (form: Declared) => {
  const validators: unknown = Reflect.get(form, "validators");

  return Option.fromUndefinedOr(
    ["onChange", "onBlur", "onSubmit", "onMount"]
      .map((moment): unknown =>
        Predicate.isObject(validators) ? Reflect.get(validators, moment) : undefined,
      )
      .find((each) => Schema.isSchema(each) && Predicate.hasProperty(each, "fields")),
  );
};

/**
 * A field's sampling seed, from its form's and its own name (FNV-1a): adding or reordering fields
 * leaves every other field's values as they were.
 */
const seedOf = (name: string) => {
  let hash = 0x811c9dc5;

  for (const char of name) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193);

  return hash >>> 0;
};

/**
 * Values for a field: its schema's boundaries, then values sampled from it (seeded, so every run
 * tries the same ones).
 */
const sampled = (
  form: Declared,
  field: string,
  seed: number,
): Option.Option<ReadonlyArray<unknown>> =>
  Option.flatMap(schemaOf(form), (schema) => {
    const fields: unknown = Reflect.get(schema as object, "fields");
    const fieldSchema: unknown = Predicate.isObject(fields)
      ? Reflect.get(fields, field)
      : undefined;

    if (!Schema.isSchema(fieldSchema)) return Option.none();

    // SAFETY: a field of a struct schema is a schema; sampling it needs no services.
    const arbitrary = Arbitrary.schema(fieldSchema as Schema.Top & Schema.Constraint);

    return Option.some([
      ...boundaries(fieldSchema),
      ...Effect.runSync(Arbitrary.sampleEffect(arbitrary, { count: 3, seed })),
    ]);
  });

/**
 * The values at a string field's declared edge, which random samples rarely reach (they stay
 * short): the longest value its schema accepts (`Schema.isMaxLength(60)`), as one word of the
 * widest letter, since an unbreakable word is what a layout fails on. Read from the schema's
 * checks, so every run tries the same values.
 */
const boundaries = (schema: Schema.Top): ReadonlyArray<string> =>
  (schema.ast.checks ?? []).flatMap((check) =>
    Option.liftPredicate(
      Reflect.get(check.annotations ?? {}, "arbitraryConstraint"),
      Predicate.isObject,
    ).pipe(
      Option.map((constraint) => Reflect.get(constraint, "maxLength")),
      Option.filter(Predicate.isNumber),
      Option.filter((length) => length > 0),
      Option.map((length) => "W".repeat(length)),
      Option.toArray,
    ),
  );

/** Whether a declared form's values can be generated: its validator is an Effect Schema struct. */
type Generated<F> = F extends { readonly validators?: infer V }
  ? V extends { readonly onChange?: infer S }
    ? S extends Schema.Top
      ? true
      : false
    : false
  : false;

/** What `Form.typing` types: which fields, which values, into how many instances. */
export type Typing<F extends Declared> = {
  /** The fields typed into (default: every field of the form's default values). */
  readonly fields?: ReadonlyArray<FieldOf<F>>;
  /** How many mounted instances are typed into, by mount order (default 1: the first). */
  readonly instances?: number;
  /** The source's name in a failure's moves (default `typing`). */
  readonly name?: string;
} & (Generated<F> extends true
  ? { readonly values?: { readonly [K in FieldOf<F>]?: ReadonlyArray<ValuesOf<F>[K]> } }
  : { readonly values: { readonly [K in FieldOf<F>]?: ReadonlyArray<ValuesOf<F>[K]> } });

/** A move of `Form.typing`: a field, a value, and the instance (by mount order) it goes into. */
export type Typed = { readonly field: string; readonly value: unknown; readonly instance: number };

/** Types into one instance by mount order. */
const typeInto = (form: Declared, typed: Typed): Step =>
  staged(`${nameOf(form)}: set ${typed.field} to ${json(typed.value)}`, async (stage) => {
    const all = instancesOf(form);
    const api = all[typed.instance];

    if (!api)
      throw new Mismatch(`no ${nameOf(form)} #${typed.instance + 1} is mounted`, [
        `mounted: ${all.map((each, index) => describe(form, each, index)).join("; ") || "none"}`,
      ]);

    api.setFieldValue(typed.field, typed.value);
    await settled(stage);
  });

/**
 * The user typing into a form, as an exploration's source: every field (or `fields`), every value
 * (its own `values`, or its Effect Schema's boundaries and values sampled from it), into the
 * first mounted instance (or the first `instances`). Forms no source names do not join the exploration.
 */
export const typing = <F extends Declared>(form: F, options: Typing<F>): AnySource => {
  const defaults: unknown = Reflect.get(form, "defaultValues");
  const fields: ReadonlyArray<string> =
    options.fields ?? (Predicate.isObject(defaults) ? Object.keys(defaults) : []);
  const given: object = options.values ?? {};

  const moves = fields.flatMap((field): ReadonlyArray<Typed> => {
    const values = Option.getOrThrowWith(
      Option.orElse(
        Option.filter(Option.fromUndefinedOr<unknown>(Reflect.get(given, field)), Array.isArray),
        () => sampled(form, field, seedOf(`${nameOf(form)}.${field}`)),
      ),
      () =>
        new Error(
          `Form.typing: no values for ${field}: its form has no Effect Schema validator to sample them from; pass values: { ${field}: [...] }`,
        ),
    );

    return Array.from({ length: options.instances ?? 1 }, (_, instance) =>
      values.map((value) => ({ field, value, instance })),
    ).flat();
  });

  return {
    name: options.name ?? "typing",
    values: moves,
    step: (typed: Typed) => typeInto(form, typed),
    // `title "Ada 2"`, and which instance when there are several.
    label: (typed: Typed) => {
      let value = JSON.stringify(typed.value) ?? String(typed.value);

      if (value.length > 24) value = `${value.slice(0, 23)}…"`;

      const shown = `${typed.field} ${value}`;

      if ((options.instances ?? 1) > 1) return `${shown} (#${typed.instance + 1})`;

      return shown;
    },
  };
};
