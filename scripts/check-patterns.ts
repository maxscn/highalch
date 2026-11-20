/**
 * The packages' confinement rules, checked on their sources (tests excluded):
 *
 * - `@lowalch/tanstack-db` imports only effect, alchemy Domain, TanStack DB and React; XState only in its
 *   `xstate` entry.
 * - `@highalch/story` additionally imports `@lowalch/tanstack-db`; XState only in its `xstate` entry;
 *   takumi, happy-dom, react-dom and node files only in its `screen` entry.
 * - Neither reaches an XState or screen entry from outside it (type-only imports are erased).
 * - `@lowalch/tanstack-db` never imports the story kit.
 * - Neither uses React effects: lifetimes are external-store subscriptions and callback refs.
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
const screen =
  /^(?:takumi-js|happy-dom|react-dom|@effect\/atom-react|node:(?:fs|path|url|zlib))(?:\/|$)/;
const effects = ["useEffect", "useLayoutEffect", "useInsertionEffect"];

export const checkPatterns = (root = fileURLToPath(new URL("../", import.meta.url))) => {
  const problems: Array<Problem> = [];
  const db = join(root, "packages/tanstack-db/src");
  const story = join(root, "packages/story/src");
  const inside = (file: string, directory: string) =>
    file === directory || file.startsWith(`${directory}/`);

  for (const file of [...files(db), ...files(story)]) {
    const text = readFileSync(file, "utf8");
    const { program } = parseSync(file, text);
    const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;

    const report = (node: Declaration, message: string) =>
      problems.push({ file: relative(root, file), line: lineOf(node.start), message });

    const inDb = inside(file, db);
    const xstateEntry = inside(file, join(db, "xstate")) || inside(file, join(story, "xstate"));
    const screenEntry = inside(file, join(story, "screen"));

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
        !(!inDb && /^@lowalch\/tanstack-db(?:\/|$)/.test(module)) &&
        !(xstateEntry && xstate.test(module)) &&
        !(screenEntry && screen.test(module))
      )
        report(
          node,
          `${module}: the packages import only effect, alchemy Domain, TanStack DB and React (XState only in the xstate entries; takumi, happy-dom, react-dom, @effect/atom-react and node files only in @highalch/story/screen)`,
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
        !typeOnly &&
        (module === "@highalch/story/screen" || inside(resolved, join(story, "screen")))
      )
        report(
          node,
          "Only @highalch/story/screen imports takumi, happy-dom and react-dom: other entries do not",
        );

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
