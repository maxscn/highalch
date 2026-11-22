import * as fc from "fast-check";
import * as Edge from "./edge.ts";
import { schemaHash } from "./hash.ts";
import { build, type JsonSchema, type Tagged } from "./schema.ts";

/** What is being exercised: a component, a part (a composition) or a page. */
export interface Subject {
  readonly kind: "component" | "part" | "page";
  /** Unique per project and kind; may be path-like (`customer/CustomerCard`). */
  readonly name: string;
}

/** A JSON Schema or any fast-check arbitrary. */
export type Source<T> = JsonSchema<T> | fc.Arbitrary<T>;

export interface ArbitraryOptions {
  /** Edge kinds to inject. Default: all {@link Edge.kinds}. `[]` disables injection. */
  readonly edges?: ReadonlyArray<Edge.Kind>;
}

export interface CasesOptions extends ArbitraryOptions {
  readonly seed: number;
  /** Number of cases. Default 100. */
  readonly count?: number;
  /** Case set name. Default: the schema's `title`, else `$id`, else `"cases"`. */
  readonly name?: string;
  /** What these cases exercise. Snapshots are compared per (subject, seed, index). */
  readonly subject: Subject;
  /**
   * Generator version. Required in spirit for a raw fast-check arbitrary (its hash is
   * `unversioned` otherwise); for a JSON Schema the hash of the schema is used.
   */
  readonly version?: string;
}

/** One deterministic generated value. `seed` + `path` replay it with fast-check. */
export interface Case<T> {
  readonly name: string;
  readonly subject: Subject;
  /** `s1:<hash of the JSON Schema>`, `v:<version>`, or `unversioned`. */
  readonly schemaHash: string;
  /** `<seed>:<index>`; stable for (seed, index). */
  readonly id: string;
  readonly index: number;
  readonly seed: number;
  readonly path: string;
  readonly value: T;
  readonly edges: ReadonlyArray<Edge.Edge>;
}

export const isArbitrary = <T>(source: Source<T>): source is fc.Arbitrary<T> =>
  source instanceof fc.Arbitrary ||
  (typeof (source as { generate?: unknown }).generate === "function" &&
    typeof (source as { shrink?: unknown }).shrink === "function");

const wanted = (options: ArbitraryOptions) => new Set(options.edges ?? Edge.kinds);

/** The tagged arbitrary behind {@link arbitrary} and {@link cases}. */
export const tagged = <T>(
  source: Source<T>,
  options: ArbitraryOptions = {},
): fc.Arbitrary<Tagged> => {
  const edges = wanted(options);
  return isArbitrary(source)
    ? source.map((value) => ({ value, edges: Edge.classify(value, edges) }))
    : build(source, edges);
};

/**
 * JSON Schema to a plain fast-check arbitrary, composable with `fc.property`, `.map`,
 * `.filter`. Edge values are injected but untagged (see {@link cases} for tags).
 * Throws `UnsupportedKeyword` / `InvalidSchema` eagerly.
 */
export const arbitrary = <T = unknown>(
  schema: JsonSchema<T>,
  options: ArbitraryOptions = {},
): fc.Arbitrary<T> => build(schema, wanted(options)).map((item) => item.value as T);

const label = <T>(source: Source<T>, name: string | undefined) => {
  if (name !== undefined) return name;
  if (isArbitrary(source)) return "cases";
  const title = source.title ?? source.$id;
  return typeof title === "string" && title !== "" ? title : "cases";
};

/**
 * Generates `count` deterministic cases. Case `index` is fast-check run `index` for `seed`,
 * so `fc.assert(fc.property(Fuzz.arbitrary(schema, { edges }), check), { seed, path })`
 * replays it. For an arbitrary source, edges are found by inspecting the value.
 */
export const cases = <T>(source: Source<T>, options: CasesOptions): ReadonlyArray<Case<T>> => {
  const name = label(source, options.name);
  const hash = schemaHash(source, isArbitrary(source), options.version);
  const out: Array<Case<T>> = [];
  fc.check(
    fc.property(tagged(source, options), (item) => {
      const index = out.length;
      out.push({
        name,
        subject: options.subject,
        schemaHash: hash,
        id: `${options.seed}:${index}`,
        index,
        seed: options.seed,
        path: String(index),
        value: item.value as T,
        edges: item.edges,
      });
    }),
    { seed: options.seed, numRuns: options.count ?? 100 },
  );
  return out;
};

/** Regenerates the value of a case from its `seed` and `path` (same source and `edges`). */
export const replay = <T>(
  source: Source<T>,
  at: { readonly seed: number; readonly path: string } & ArbitraryOptions,
): T => {
  let value: unknown;
  fc.check(
    fc.property(tagged(source, at), (item) => {
      value = item.value;
    }),
    { seed: at.seed, path: at.path, numRuns: 1 },
  );
  return value as T;
};
