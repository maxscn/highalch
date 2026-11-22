# @highalch/console-fuzz

Seeded fuzzing built on [fast-check](https://fast-check.dev) (a layer over it: everything returns
plain `fc.Arbitrary` values and fast-check seeds/paths). `fast-check` is a peer dependency.

```ts
import { Console, Fuzz } from "@highalch/console-fuzz";
import { fromEffect } from "@highalch/console-fuzz/effect";
import { reactHtml } from "@highalch/console-fuzz/react";
import { screenshot } from "@highalch/console-fuzz/playwright";
import { reporter } from "@highalch/console-fuzz/reporter"; // same as Console.reporter
```

## API

```ts
Fuzz.arbitrary<T>(schema: Fuzz.JsonSchema<T>, options?: { edges?: Fuzz.EdgeKind[] }): fc.Arbitrary<T>

Fuzz.cases<T>(source: Fuzz.JsonSchema<T> | fc.Arbitrary<T>,
  options: { subject: { kind: "component" | "part" | "page"; name: string }; seed: number;
             count?: number /* 100 */; edges?: Fuzz.EdgeKind[]; name?: string; version?: string }): Fuzz.Case<T>[]
// Case: { name, subject, schemaHash, id: "<seed>:<index>", index, seed, path: "<index>", value,
//         edges: [{ kind, path: "/customer/name" }] }
// schemaHash: "s1:<hash of the canonical JSON Schema>", "v:<version>", or "unversioned" (raw arbitrary)

Fuzz.replay<T>(source, { seed, path, edges? }): T           // = fc.assert(fc.property(arb, …), { seed, path })

Fuzz.run<S, A>({ subject, seed, steps, version?, runs? /* 100 */, name?, initial, actions, edges?,
  step: (state: S, action: A) => S, invariant?: (state: S) => void,
  capture?: (state: S, ctx: CaseContext) => Capture | Promise<Capture> }): Promise<Fuzz.Run<S, A>>
// Run: { name, subject, schemaHash, seed, initial, trace: [{ index, action, state, capture? }],
//        failure: { error, message, index, counterexample, seed, path, shrinks } | null }
Fuzz.assertRun(options): Promise<Fuzz.Run<S, A>>            // like fc.assert: rejects with
// Fuzz.RunFailed { run, failure, seed, path, counterexample, cause } when a sequence fails
Fuzz.sequence(actions, steps, options?)                     // the action-sequence arbitrary Fuzz.run explores

fromEffect(schema): Fuzz.JsonSchema<Encoded>                // Effect Schema -> JSON Schema (draft 2020-12)

interface Adapter<Subject> { kind: "html" | "screenshot"; capture(subject, ctx: CaseContext): Promise<Capture> }
reactHtml({ head?, mode?: "dom" | "server" }): Adapter<ReactElement>     // happy-dom friendly
screenshot({ fullPage?, ...LocatorScreenshotOptions }): Adapter<Page | Locator>   // PNG

const report = Console.reporter({ strict?, log?, ...ClientOptions }) // HIGHALCH_URL + HIGHALCH_API_KEY or GitHub OIDC
report.add(c, capture?, { state?, outcome?: "ok" | "overflow" | "crash" | "a11y", message? })
report.trace(run)
await report.flush() // { status: "uploaded" | "written" | "empty" | "failed", ... }
```

**Subjects and snapshots.** Every case set and trace names the component, part or page it
exercises (`subject`). The server compares each capture with the baseline run's capture for the
same (subject, seed, index[, step]) and reports `unchanged`, `changed`, `new`, `removed` or
`schema-changed` (when `schemaHash` differs). Give a raw fast-check arbitrary a `version`.

**Determinism.** Case `i` is fast-check run `i` for `seed`; the same seed gives byte-identical
cases (a pinned digest test guards this). `Fuzz.run` explores `runs` sequences of exactly `steps`
actions; on failure fast-check shrinks (dropping and simplifying actions) and the trace replays the
shrunk counterexample, otherwise the first sequence (path `"0"`). `capture` runs only for the
reported trace.

**Edges.** Kinds: `long-string`, `empty`, `rtl`, `whitespace`, `emoji`, `markup`, `negative`,
`zero`, `huge-number`, `many-items` (default: all; `[]` disables). From a JSON Schema they are
injected (about 1 in 5 eligible values) within the schema's bounds and tagged with the JSON pointer
where they landed. From a plain `fc.Arbitrary` they are found by inspecting the value.

**JSON Schema.** Supported: `type` (incl. arrays), `nullable`, `enum`, `const`, `anyOf`, `oneOf`
(generates one branch; exclusivity not enforced), `$ref` to `#`, `#/$defs/*`, `#/definitions/*`
(recursion allowed, depth-capped), `properties`, `required`, `additionalProperties`,
`patternProperties`, `items` (schema or draft-07 tuple), `prefixItems`, `minItems`, `maxItems`,
`uniqueItems`, `minLength`, `maxLength` (code points), `pattern`, `format` (`date-time`, `date`,
`time`, `email`, `uuid`, `uri`, `url`, `uri-reference`, `iri`, `hostname`, `ipv4`, `ipv6`),
`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` (number or draft-04 boolean),
`multipleOf`. Ignored annotations: `$schema`, `$id`, `$comment`, `$anchor`, `title`,
`description`, `default`, `examples`, `readOnly`, `writeOnly`, `deprecated`, `contentEncoding`,
`contentMediaType`, `x-*`. Anything else (e.g. `allOf`, `not`, `if`/`then`/`else`, `contains`,
`propertyNames`, `min/maxProperties`, `dependent*`, `unevaluated*`, `$dynamicRef`), unknown
formats, external `$ref`s and constraint keywords next to `$ref`/`anyOf`/`oneOf` throw
`Fuzz.UnsupportedKeyword { keyword, pointer }`; malformed or unsatisfiable schemas throw
`Fuzz.InvalidSchema { pointer, message }`.

`fromEffect` describes the schema's JSON encoding; decode generated values with
`Schema.decodeUnknownSync(Schema.toCodecJson(schema))`. Effect checks that JSON Schema cannot
express (e.g. `DateTimeUtcFromString` has no `format`) may produce values the decoder rejects.
