/**
 * The packages' confinement rules, checked on their sources (tests excluded). Each package imports
 * only what its row below allows, and reaches another package only by its entries (never its
 * `src` by a relative path):
 *
 * - `@lowalch/tanstack-db` imports effect, alchemy Domain, TanStack DB and React; TanStack's
 *   offline transactions only in its `offline` entry; XState only in
 *   its `xstate` entry. It never imports HighAlch.
 * - `@highalch/story`, the runner, imports effect and the node files keeping traces: no data
 *   layer, no UI, no alchemy. Adapters add those, each in its own package.
 * - `@highalch/tanstack-db` adds TanStack DB; `@highalch/xstate` XState and LowAlch's commands;
 *   `@highalch/screen` happy-dom, React DOM and node files; `@highalch/takumi` takumi; and
 *   `@highalch/tanstack-form` TanStack Form. Screens and machines reach the data layer through the
 *   story's `Data` interface, never `@highalch/tanstack-db`. Only `@highalch/alchemy-domain` (and `@highalch/xstate`,
 *   for LowAlch's commands) touch alchemy or LowAlch.
 * - `@highalch/stream` imports only effect: the console decodes with it, without the test kit.
 *   `@highalch/studio` adds `ws` and node; `@highalch/explore` adds the story kit and node files,
 *   XState only in its `xstate` entry.
 * - None uses React effects: lifetimes are external-store subscriptions and callback refs.
 * - No module exports `then`: `import()` would treat the module as a thenable and hang.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite-plus";

type Problem = { readonly file: string; readonly line: number; readonly message: string };

/** The parts of an oxc import or re-export declaration this script reads. */
type Declaration = {
  readonly type: string;
  readonly start: number;
  readonly source?: { readonly value: string } | null;
  readonly specifiers?: ReadonlyArray<{
    readonly imported?: { readonly name?: string; readonly value?: string };
  }>;
};

/** What a package may import: modules matching `allows`, and in some entries (folders), more. */
type Package = {
  readonly name: string;
  readonly folder: string;
  readonly allows: RegExp;
  readonly entries?: Readonly<Record<string, RegExp>>;
};

/** One pattern matching any of these. */
const of = (...patterns: ReadonlyArray<RegExp>) =>
  new RegExp(patterns.map((pattern) => `(?:${pattern.source})`).join("|"));

const effect = /^effect(?:\/|$)/;
const react = /^react$/;
const tanstack = /^@tanstack\/db$/;
const alchemy = /^@alchemy\.run\/domain(?:\/|$)/;
const story = /^@highalch\/story(?:\/internal)?$/;
const db = /^@highalch\/tanstack-db(?:\/internal)?$/;
const lowalch = /^@lowalch\/tanstack-db(?:\/(?:internal|react|xstate))?$/;
const xstate = /^(?:xstate|@xstate\/effect)(?:\/|$)/;

const packages: ReadonlyArray<Package> = [
  {
    name: "@lowalch/tanstack-db",
    folder: "packages/lowalch/tanstack-db/src",
    allows: of(effect, react, alchemy, /^@tanstack\/(?:db|react-db)$/),
    entries: { xstate, offline: /^@tanstack\/offline-transactions$/ },
  },
  {
    name: "@highalch/story",
    folder: "packages/highalch/story/src",
    allows: of(effect, /^node:(?:fs\/promises|path|url)$/),
  },
  {
    name: "@highalch/tanstack-db",
    folder: "packages/highalch/tanstack-db/src",
    allows: of(effect, react, tanstack, /^@tanstack\/react-db$/, story),
  },
  {
    name: "@highalch/xstate",
    folder: "packages/highalch/xstate/src",
    allows: of(effect, story, lowalch, xstate),
  },
  {
    name: "@highalch/screen",
    folder: "packages/highalch/screen/src",
    allows: of(
      effect,
      react,
      story,
      /^(?:happy-dom|react-dom|@effect\/atom-react)(?:\/|$)/,
      /^node:(?:fs|fs\/promises|path|url|zlib)$/,
    ),
  },
  {
    name: "@highalch/takumi",
    folder: "packages/highalch/takumi/src",
    allows: of(effect, /^@highalch\/screen(?:\/internal)?$/, /^takumi-js(?:\/|$)/, /^node:fs/),
  },
  {
    name: "@highalch/tanstack-form",
    folder: "packages/highalch/tanstack-form/src",
    allows: of(effect, react, story, /^@tanstack\/(?:react-form|form-core)$/),
  },
  {
    name: "@highalch/alchemy-domain",
    folder: "packages/highalch/alchemy-domain/src",
    allows: of(effect, react, tanstack, story, db, lowalch, alchemy),
  },
  {
    name: "@highalch/stream",
    folder: "packages/highalch/stream/src",
    allows: effect,
  },
  {
    name: "@highalch/studio",
    folder: "packages/highalch/studio/src",
    allows: of(effect, /^@highalch\/stream$/, /^ws$/, /^node:/),
  },
  {
    name: "@highalch/explore",
    folder: "packages/highalch/explore/src",
    allows: of(effect, /^@highalch\/(?:story|stream)$/, /^node:(?:fs|fs\/promises|path|url)$/),
    entries: { xstate: /^xstate(?:\/|$)/ },
  },
];

const effects = ["useEffect", "useLayoutEffect", "useInsertionEffect"];

const files = (directory: string): Array<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) return files(path);

    if (/\.tsx?$/.test(path) && !/\.test\./.test(path)) return [path];

    return [];
  });

export const checkPatterns = (root = fileURLToPath(new URL("../", import.meta.url))) => {
  const problems: Array<Problem> = [];

  for (const pkg of packages) {
    const folder = join(root, pkg.folder);

    for (const file of files(folder)) {
      const text = readFileSync(file, "utf8");
      const { program } = parseSync(file, text);
      const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
      // The entry a file belongs to: the folder under `src` it is in (none at the top).
      const extra = pkg.entries?.[relative(folder, dirname(file)).split("/")[0] ?? ""];
      const allowed = (module: string) =>
        pkg.allows.test(module) || (extra !== undefined && extra.test(module));

      const report = (node: Declaration, message: string) =>
        problems.push({ file: relative(root, file), line: lineOf(node.start), message });

      // SAFETY: oxc's program body; only the fields of `Declaration` are read.
      for (const node of program.body as unknown as ReadonlyArray<Declaration>) {
        if (
          !["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(
            node.type,
          ) ||
          !node.source
        )
          continue;

        const module = node.source.value;

        if (module.startsWith(".")) {
          // A relative import stays inside its package: another package is reached by its entries.
          if (relative(folder, join(dirname(file), module)).startsWith(".."))
            report(node, `${module}: reaches outside ${pkg.name}: import the package by its name`);

          continue;
        }

        if (!allowed(module))
          report(
            node,
            `${module}: ${pkg.name} does not import it (scripts/check-patterns.ts lists what each package may)`,
          );

        if (
          module === "react" &&
          node.specifiers?.some((specifier) =>
            effects.includes(specifier.imported?.name ?? specifier.imported?.value ?? ""),
          )
        )
          report(node, "HighAlch does not use React effects");
      }

      // A module that exports `then` is a thenable: `import()` of it waits on it and never settles.
      const thenable = text.search(
        /^export\s+(?:const|let|var|function|async\s+function)\s+then\b|^export\s*\{[^}]*\bas\s+then\b|^export\s*\{[^}]*(?:^|[\s,{])then\s*[,}]/m,
      );

      if (thenable >= 0)
        problems.push({
          file: relative(root, file),
          line: lineOf(thenable),
          message:
            "a module must not export `then`: import() would treat it as a thenable and never settle (put `then` on a namespace object instead)",
        });

      // A namespace import of React would reach effects without naming them in the import.
      if (/\bReact\.use(?:Layout|Insertion)?Effect\b/.test(text))
        problems.push({
          file: relative(root, file),
          line: lineOf(text.search(/\bReact\.use(?:Layout|Insertion)?Effect\b/)),
          message: "HighAlch does not use React effects",
        });
    }
  }

  return problems;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkPatterns();

  for (const problem of problems)
    process.stderr.write(`${problem.file}:${problem.line}: ${problem.message}\n`);

  if (problems.length > 0) process.exitCode = 1;
  else process.stdout.write("Package boundaries passed.\n");
}
