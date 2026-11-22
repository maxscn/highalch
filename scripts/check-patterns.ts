/**
 * The packages' confinement rules, checked on their sources (tests excluded):
 *
 * - `@lowalch/tanstack-db` imports only effect, alchemy Domain, TanStack DB and React; XState only in its
 *   `xstate` entry.
 * - `@highalch/story`'s root (the runner and the Domain's steps) imports neither TanStack DB nor
 *   LowAlch, nor an adapter's entry: only effect, alchemy Domain and React. Its `tanstack-db` entry
 *   adds TanStack DB, never LowAlch; LowAlch only in its `lowalch` and `xstate` entries.
 * - `@highalch/story`: XState only in its `xstate` entry;
 *   happy-dom, react-dom, `@effect/atom-react` and node files only in its `screen` entry (and
 *   the runner's own files: traces and explorations' replays, `node:fs`/`path`/`url`); takumi
 *   (and the node file reading its WASM) only in its `takumi` entry; TanStack Form only in its
 *   `tanstack-form` entry.
 * - Neither reaches an XState, screen or takumi entry from outside it (type-only imports are
 *   erased); a painter entry (`takumi`) may reach the screen entry it paints for.
 * - `@lowalch/tanstack-db` never imports the story kit.
 * - `@highalch/stream` imports only effect: the console decodes with it, without the test kit.
 * - `@highalch/explore` imports effect, `@highalch/story`'s public entries, `@highalch/stream`
 *   and the node files keeping its corpus; XState only in its `xstate` entry.
 * - `@highalch/studio` (the relay on this machine) imports effect, `@highalch/stream`, `ws` and node.
 * - `@highalch/story` imports neither `@highalch/explore` nor `@highalch/stream`.
 * - Neither uses React effects: lifetimes are external-store subscriptions and callback refs.
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
  readonly importKind?: string;
  readonly exportKind?: string;
  readonly source?: { readonly value: string } | null;
  readonly specifiers?: ReadonlyArray<{
    readonly importKind?: string;
    readonly imported?: { readonly name?: string; readonly value?: string };
  }>;
};

const files = (directory: string): Array<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) return files(path);

    if (/\.tsx?$/.test(path) && !/\.test\./.test(path)) return [path];

    return [];
  });

const core = /^(?:effect|react|@alchemy\.run\/domain|@tanstack\/(?:db|react-db))(?:\/|$)/;
const xstate = /^(?:xstate|@xstate\/effect)(?:\/|$)/;
const screen = /^(?:happy-dom|react-dom|@effect\/atom-react|node:(?:fs|path|url|zlib))(?:\/|$)/;
const takumi = /^(?:takumi-js|node:fs)(?:\/|$)/;
const form = /^@tanstack\/(?:react-form|form-core)(?:\/|$)/;
const effects = ["useEffect", "useLayoutEffect", "useInsertionEffect"];

export const checkPatterns = (root = fileURLToPath(new URL("../", import.meta.url))) => {
  const problems: Array<Problem> = [];
  const db = join(root, "packages/tanstack-db/src");
  const story = join(root, "packages/story/src");
  const stream = join(root, "packages/stream/src");
  const explore = join(root, "packages/explore/src");
  const studio = join(root, "packages/studio/src");
  const inside = (file: string, directory: string) =>
    file === directory || file.startsWith(`${directory}/`);

  for (const file of [...files(stream), ...files(explore), ...files(studio)]) {
    const text = readFileSync(file, "utf8");
    const { program } = parseSync(file, text);
    const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
    const inStream = inside(file, stream);
    const inStudio = inside(file, studio);
    const exploreXstate = inside(file, join(explore, "xstate"));

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
      const resolved = module.startsWith(".") ? join(dirname(file), module) : "";
      const effect = /^effect(?:\/|$)/.test(module);

      if (inStream && !effect && !inside(resolved, stream))
        problems.push({
          file: relative(root, file),
          line: lineOf(node.start),
          message: `${module}: @highalch/stream imports only effect, so the console can decode with it without the test kit`,
        });

      if (
        inStudio &&
        !effect &&
        !/^(?:@highalch\/stream|ws|node:[a-z_/]+)$/.test(module) &&
        !inside(resolved, studio)
      )
        problems.push({
          file: relative(root, file),
          line: lineOf(node.start),
          message: `${module}: @highalch/studio imports effect, @highalch/stream, ws and node`,
        });

      if (
        !inStream &&
        !inStudio &&
        !effect &&
        !/^@highalch\/(?:story|stream)$/.test(module) &&
        !/^node:(?:fs\/promises|path|url)$/.test(module) &&
        !(exploreXstate && xstate.test(module)) &&
        !inside(resolved, explore)
      )
        problems.push({
          file: relative(root, file),
          line: lineOf(node.start),
          message: `${module}: @highalch/explore imports effect, @highalch/story, @highalch/stream and node files (XState only in its xstate entry)`,
        });
    }
  }

  for (const file of [...files(db), ...files(story)]) {
    const text = readFileSync(file, "utf8");
    const { program } = parseSync(file, text);
    const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;

    const report = (node: Declaration, message: string) =>
      problems.push({ file: relative(root, file), line: lineOf(node.start), message });

    const inDb = inside(file, db);
    const xstateEntry = inside(file, join(db, "xstate")) || inside(file, join(story, "xstate"));
    const screenEntry = inside(file, join(story, "screen"));
    const takumiEntry = inside(file, join(story, "takumi"));
    const formEntry = inside(file, join(story, "tanstack-form"));
    const storyRoot = dirname(file) === story;
    const dbEntry = inside(file, join(story, "tanstack-db"));
    const lowalchAllowed =
      inside(file, join(story, "lowalch")) || inside(file, join(story, "xstate"));

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
      const typeOnly =
        node.importKind === "type" ||
        node.exportKind === "type" ||
        (node.specifiers !== undefined &&
          node.specifiers.length > 0 &&
          node.specifiers.every((specifier) => specifier.importKind === "type"));
      const resolved = module.startsWith(".") ? join(dirname(file), module) : "";

      if (
        !module.startsWith(".") &&
        !core.test(module) &&
        !(!inDb && lowalchAllowed && /^@lowalch\/tanstack-db(?:\/|$)/.test(module)) &&
        !(xstateEntry && xstate.test(module)) &&
        !(screenEntry && screen.test(module)) &&
        !(takumiEntry && takumi.test(module)) &&
        !(formEntry && form.test(module)) &&
        !(storyRoot && /^node:(?:fs\/promises|path|url)$/.test(module))
      )
        report(
          node,
          `${module}: the packages import only effect, alchemy Domain, TanStack DB and React (XState only in the xstate entries; happy-dom, react-dom, @effect/atom-react and node files only in @highalch/story/screen; takumi only in @highalch/story/takumi)`,
        );

      if (
        !xstateEntry &&
        !typeOnly &&
        (/^@(?:lowalch\/tanstack-db|highalch\/story)\/xstate$/.test(module) ||
          inside(resolved, join(db, "xstate")) ||
          inside(resolved, join(story, "xstate")))
      )
        report(
          node,
          "Only the xstate entries import XState: core and the plain story entry do not",
        );

      if (
        !screenEntry &&
        !takumiEntry &&
        !typeOnly &&
        (module === "@highalch/story/screen" || inside(resolved, join(story, "screen")))
      )
        report(
          node,
          "Only @highalch/story/screen imports happy-dom and react-dom: other entries do not",
        );

      if (
        !takumiEntry &&
        !typeOnly &&
        (module === "@highalch/story/takumi" || inside(resolved, join(story, "takumi")))
      )
        report(node, "Only @highalch/story/takumi imports takumi: other entries do not");

      if (
        storyRoot &&
        (/^@(?:tanstack|lowalch)\//.test(module) ||
          ["tanstack-db", "lowalch", "xstate", "screen", "takumi"].some((entry) =>
            inside(resolved, join(story, entry)),
          ))
      )
        report(
          node,
          `${module}: the story runner knows no adapter: TanStack DB, LowAlch and the adapters' entries are imported only by those entries`,
        );

      if (dbEntry && (module.startsWith("@lowalch/") || inside(resolved, join(story, "lowalch"))))
        report(
          node,
          `${module}: @highalch/story/tanstack-db works on plain TanStack DB; LowAlch lives in @highalch/story/lowalch`,
        );

      if (!inDb && /^@highalch\/(?:explore|stream)(?:\/|$)/.test(module))
        report(node, `${module}: @highalch/story knows neither explorations nor the stream`);

      if (inDb && (/^@highalch\/story(?:\/|$)/.test(module) || inside(resolved, story)))
        report(node, "@lowalch/tanstack-db never imports the story kit");

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

  return problems;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkPatterns();

  for (const problem of problems)
    process.stderr.write(`${problem.file}:${problem.line}: ${problem.message}\n`);

  if (problems.length > 0) process.exitCode = 1;
  else process.stdout.write("Package boundaries passed.\n");
}
