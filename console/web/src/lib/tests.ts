import type { TestItem } from "../data/items.ts";
import type { Status } from "../components/ui/status.tsx";

/** A test's outcome as the shared status. */
export const testStatus = (test: Pick<TestItem, "status">): Status => test.status;

/** "customers › lists every customer": describe titles and the test title. */
export const testTitle = (test: Pick<TestItem, "titlePath" | "title">) =>
  [...test.titlePath, test.title].join(" › ");

/** Browser names as the boards write them. */
export const browserName = (test: Pick<TestItem, "browser" | "project">) => {
  const name = test.browser ?? test.project;
  const known: Record<string, string> = {
    chromium: "Chromium",
    firefox: "Firefox",
    webkit: "WebKit",
  };
  return known[name.toLowerCase()] ?? name;
};

export const retriesLabel = (retries: number) =>
  retries === 0 ? "No retries" : `${retries} ${retries === 1 ? "retry" : "retries"}`;

/** One line of a code frame: its number (null for the caret line), text, and whether it is the failing line. */
export type FrameLine = { readonly n: string; readonly code: string; readonly hit: boolean };

// eslint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-9;]*m/g;

/**
 * Playwright's code frame (`snippet`): `  40 |   code`, `> 43 |   failing`, `     |   ^`.
 * The failing line and its caret are marked.
 */
export const frameLines = (snippet: string): ReadonlyArray<FrameLine> => {
  const lines = snippet.replace(ansi, "").split("\n");
  let previousHit = false;
  return lines.flatMap((line) => {
    const match = /^(>?)\s*(\d*)\s*\|(.*)$/.exec(line);
    if (match === null) return [];
    const marker = match[1] === ">";
    const number = match[2] ?? "";
    const code = (match[3] ?? "").replace(/^ /, "");
    const caret = number === "" && previousHit;
    previousHit = marker;
    return [{ n: marker ? `> ${number}` : number, code, hit: marker || caret }];
  });
};

type Step = TestItem["attempts"][number]["steps"][number];

/** The steps a reader follows: hooks and fixtures left out, nested test steps kept as one row each. */
export const visibleSteps = (steps: ReadonlyArray<Step>): ReadonlyArray<Step> =>
  steps.filter((step) => step.category !== "hook" && step.category !== "fixture");
