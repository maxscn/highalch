import { StoryReport, type RuleResult } from "@highalch/console-client/StoryReport";

/**
 * A story report (`story.json`, `highalch.story/1`) as the story pages read
 * it, decoded with the Console's copy of HighAlch's schema (`@highalch/console-client/StoryReport`;
 * HighAlch's own once story reports land there): every step (kind, label,
 * status, timing, its frame, the world after it and the rules judged after it), the failure in
 * full and an exploration's replayed sequence. `StoryRows` keep only each story's summary and
 * the report's artifact id. Unknown fields are ignored, so newer reports still decode.
 */
export { StoryReport };

type Snapshot = NonNullable<StoryReport["steps"][number]["world"]>;

/**
 * The world after a step as the pages show it: every part the runner and its adapters reported
 * (none: empty), and the rules judged after the step.
 */
export type World = {
  readonly sources: NonNullable<Snapshot["sources"]>;
  readonly commands: NonNullable<Snapshot["commands"]>;
  readonly wires: NonNullable<Snapshot["wires"]>;
  readonly machines: NonNullable<Snapshot["machines"]>;
  readonly server: Snapshot["server"] | null;
  readonly rules: ReadonlyArray<RuleResult>;
};

type Frame = NonNullable<StoryReport["steps"][number]["frame"]>;

/**
 * A step as the story pages show it, from the report: its frame resolved to the run's artifact
 * holding it (by digest), when the run uploaded it.
 */
export type ShownStep = {
  readonly n: number;
  readonly kind: string;
  readonly label: string;
  readonly status: "passed" | "failed" | "not-run";
  readonly durationMs: number | null;
  readonly clock: number | null;
  /** Whether the story was at rest after the step. */
  readonly rest: boolean | null;
  readonly world: World | null;
  readonly frame: {
    readonly file: string;
    readonly status: Frame["status"];
    readonly differing: number | null;
    readonly artifact: string | null;
  } | null;
};

export const shownSteps = (
  report: StoryReport,
  artifactOf: (sha256: string) => string | undefined,
): ReadonlyArray<ShownStep> =>
  [...report.steps]
    .sort((a, b) => a.n - b.n)
    .map((step) => ({
      n: step.n,
      kind: step.kind,
      label: step.label,
      status: step.status,
      durationMs: step.durationMs ?? null,
      clock: step.clock ?? null,
      rest: step.rest ?? null,
      world:
        step.world === undefined
          ? null
          : {
              sources: step.world.sources ?? [],
              commands: step.world.commands ?? [],
              wires: step.world.wires ?? [],
              machines: step.world.machines ?? [],
              server: step.world.server ?? null,
              rules: step.rules,
            },
      frame:
        step.frame === undefined
          ? null
          : {
              file: step.frame.file,
              status: step.frame.status,
              differing: step.frame.differing ?? null,
              artifact: artifactOf(step.frame.sha256) ?? null,
            },
    }));

/** A row as the boards print it: `{ NoteId: "n1", title: "Ada" }`. */
export const rowText = (row: unknown): string => {
  if (row === null || typeof row !== "object") return JSON.stringify(row);
  const fields = Object.entries(row).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `{ ${fields.join(", ")} }`;
};
