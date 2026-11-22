/**
 * Story reports for the development seed: HighAlch's own notebook stories (the ones its
 * `@highalch/story` tests tell), as `story.json` reports (typed by `StoryReport` of
 * `@highalch/console-client`), with their reviewed frames (copied from HighAlch's story test
 * baselines into `./frames`). The same stories appear on every commit of pull request #57 of
 * `notes-app`, passing or failing as the design boards (Stories, Story, StoryFailure, Explore)
 * show them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { StoryHeader, StorySummary } from "@highalch/console-domain/Story/Story.values";
import type { StoryReport } from "@highalch/console-client/StoryReport";

const baselines = join(import.meta.dirname, "frames");

const encoder = new TextEncoder();
const sha256 = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

/** A file CI uploads with a story: its report or a frame. `local` names it until declared. */
export type StoryFile = {
  readonly local: string;
  readonly name: string;
  readonly mime: string;
  readonly body: Uint8Array;
};

export type SeedStory = {
  readonly header: StoryHeader;
  /** What its steps add up to (the steps themselves stay in its report). */
  readonly summary: StorySummary;
  /** The local ids of its frames, declared as artifacts of the run. */
  readonly frames: ReadonlyArray<string>;
  readonly files: ReadonlyArray<StoryFile>;
};

/** Which commit of pull request #57 a run is on: each tells the stories a little differently. */
export type Moment = "base" | "field" | "settle" | "debounce" | "pending";

// ---------------------------------------------------------------- the world, as a report holds it

type Row = { readonly NoteId: string; readonly title: string };
type Shown = { readonly key: string; readonly row: Row; readonly pending: boolean };

const ada: Row = { NoteId: "n1", title: "Ada" };
const bob: Row = { NoteId: "n2", title: "Bob" };
const list = 'notes.list({"account":"acc-1"})';

type Command = {
  readonly name: string;
  readonly input: { readonly [field: string]: string };
  readonly outcome: NonNullable<Snapshot["commands"]>[number]["outcome"];
};

type World = {
  readonly state?: string;
  readonly rows?: ReadonlyArray<Shown>;
  readonly command?: Command;
  readonly feed?: "live" | "dropped" | "muted";
  readonly asked?: ReadonlyArray<string>;
  readonly held?: boolean;
  /** Rules that do not hold after the step: their name and what they read. */
  readonly broken?: ReadonlyArray<readonly [string, string]>;
  readonly machine?: { readonly state: string; readonly context: object };
};

type Rules = StoryReport["rules"];

/** The rules `Db.rules` keeps (LowAlch's feed rules run inside the clients' own). */
const dbRules: Rules = [
  { name: "nothing is pending at rest", at: "rest" },
  { name: "the clients' own rules hold", at: "step" },
];

type Step = StoryReport["steps"][number];
type Snapshot = NonNullable<Step["world"]>;

const worldOf = (world: World, step: number): Snapshot => ({
  server: { idle: true },
  wires:
    world.feed === undefined
      ? []
      : [
          {
            scope: "acc-1",
            feed: world.feed,
            inflight: 0,
            held: world.held === true ? 1 : 0,
            sent: world.command === undefined ? 0 : 1,
            asked: world.asked ?? ["Notes"],
          },
        ],
  sources:
    world.rows === undefined
      ? []
      : [
          {
            id: list,
            scope: "acc-1",
            state: { _tag: world.state ?? "Ready" },
            count: world.rows.length,
            rows: world.rows,
            truncated: false,
          },
        ],
  commands:
    world.command === undefined
      ? []
      : [
          {
            label: `${world.command.name} ${JSON.stringify(world.command.input)}`,
            scope: "acc-1",
            by: "story",
            key: world.command.input.NoteId ?? "",
            commandId: "c1",
            input: world.command.input,
            step,
            outcome: world.command.outcome,
          },
        ],
  machines:
    world.machine === undefined
      ? []
      : [
          {
            name: "editor",
            mode: "running",
            mounted: false,
            state: world.machine.state,
            context: { ...world.machine.context },
            asked: [],
          },
        ],
});

/** The rules judged after a step: those due at its moment, a broken one last. */
const judged = (world: World, rules: Rules): Step["rules"] =>
  rules.map((rule) => {
    const broken = world.broken?.find(([name]) => name === rule.name);
    return broken === undefined
      ? { ...rule, held: true }
      : { ...rule, held: false, read: [broken[1]] };
  });

type StepPlan = {
  readonly kind: string;
  readonly label: string;
  readonly world: World;
  /** The baseline frame shown after the step (`<story>/<file>`), if a screen captured one. */
  readonly frame?: {
    readonly story: string;
    readonly file: string;
    readonly status?: "matched" | "created" | "mismatch";
    readonly differing?: number;
    readonly actual?: string;
  };
  readonly failed?: boolean;
};

type Plan = {
  readonly slug: string;
  readonly name: string;
  readonly test: { readonly file: string; readonly name: string };
  readonly durationMs: number;
  readonly rules: Rules;
  readonly steps: ReadonlyArray<StepPlan>;
  /** The step that failed, and why (`StoryFailure`); later steps did not run. */
  readonly failure?: {
    readonly step: number;
    readonly reason: string;
    readonly detail: ReadonlyArray<string>;
  };
  /** An exploration's replay: the sequence it replays, as found and shrunk. */
  readonly explore?: NonNullable<StoryReport["explore"]>;
  readonly histories?: ReadonlyArray<{
    readonly tick: number;
    readonly step: number;
    readonly key: string;
    readonly row?: Row;
    readonly pending?: boolean;
  }>;
};

const frame = (run: string, plan: Plan, step: StepPlan, n: number, files: Array<StoryFile>) => {
  if (step.frame === undefined) return null;
  const source = step.frame.actual ?? step.frame.file;
  const body = new Uint8Array(readFileSync(join(baselines, step.frame.story, source)));
  const local = `${run}/${plan.slug}/${n}`;
  files.push({ local, name: `${plan.slug}/${step.frame.file}`, mime: "image/png", body });
  return {
    file: step.frame.file,
    status: step.frame.status ?? "matched",
    sha256: sha256(body),
    artifact: local,
    differing: step.frame.differing ?? null,
  } as const;
};

const build = (run: string, plan: Plan): SeedStory => {
  const files: Array<StoryFile> = [];
  const failedAt = plan.failure?.step;
  const status = (n: number) =>
    failedAt === undefined || n < failedAt
      ? ("passed" as const)
      : n === failedAt
        ? ("failed" as const)
        : ("not-run" as const);
  const steps = plan.steps.map((step, index) => {
    const n = index + 1;
    const ran = status(n) !== "not-run";
    return {
      n,
      kind: step.kind,
      label: step.label,
      status: status(n),
      scope: "acc-1",
      durationMs: ran ? 12 + ((n * 37) % 90) : null,
      clock: ran ? 0 : null,
      frame: ran ? frame(run, plan, step, n, files) : null,
    };
  });
  const report: StoryReport = {
    format: "highalch.story/1",
    name: plan.name,
    slug: plan.slug,
    test: plan.test,
    status: failedAt === undefined ? "passed" : "failed",
    durationMs: plan.durationMs,
    host: "memory",
    scope: "acc-1",
    clock: "manual",
    rules: plan.rules,
    ...(plan.failure === undefined
      ? {}
      : { failure: { ...plan.failure, detail: [...plan.failure.detail] } }),
    steps: plan.steps.map((step, index) => {
      const shown = steps[index];
      return {
        n: index + 1,
        kind: step.kind,
        label: step.label,
        status: status(index + 1),
        ...(status(index + 1) === "not-run" || shown === undefined
          ? { rules: [] }
          : {
              durationMs: shown.durationMs ?? 0,
              clock: 0,
              rest: true,
              world: worldOf(step.world, index + 1),
              ...(shown.frame === null
                ? {}
                : {
                    frame: {
                      file: shown.frame.file,
                      status: shown.frame.status,
                      sha256: shown.frame.sha256,
                      ...(shown.frame.differing === null
                        ? {}
                        : { differing: shown.frame.differing }),
                    },
                  }),
              rules: judged(step.world, plan.rules),
            }),
      };
    }),
    ...(failedAt === undefined ? { end: { rules: judged({}, plan.rules) } } : {}),
    histories: [{ id: list, scope: "acc-1", shown: [...(plan.histories ?? [])] }],
    feeds: [
      {
        scope: "acc-1",
        entries: [
          { seq: 1, commandId: "given-1", entity: "NoteRows", key: "n1", row: ada },
          { seq: 2, commandId: "given-2", entity: "NoteRows", key: "n2", row: bob },
        ],
      },
    ],
    ...(plan.explore === undefined ? {} : { explore: plan.explore }),
  };
  const body = encoder.encode(JSON.stringify(report));
  const reportLocal = `${run}/${plan.slug}/story.json`;
  files.unshift({
    local: reportLocal,
    name: `${plan.slug}/story.json`,
    mime: "application/json",
    body,
  });
  return {
    header: {
      slug: plan.slug,
      name: plan.name,
      test: plan.test,
      status: failedAt === undefined ? "passed" : "failed",
      durationMs: plan.durationMs,
      host: "memory",
      scope: "acc-1",
      clock: "manual",
      invariants: plan.rules.map((rule) => rule.name),
      failure:
        plan.failure === undefined
          ? null
          : { step: plan.failure.step, reason: plan.failure.reason },
      explore:
        plan.explore === undefined
          ? null
          : { model: plan.explore.name, path: plan.explore.index, of: plan.explore.of },
      report: reportLocal,
    },
    summary: {
      steps: {
        passed: steps.filter((step) => step.status === "passed").length,
        failed: steps.filter((step) => step.status === "failed").length,
        notRun: steps.filter((step) => step.status === "not-run").length,
      },
      kinds: [...new Set(steps.map((step) => step.kind))],
      frames: {
        matched: steps.filter((step) => step.frame?.status === "matched").length,
        created: steps.filter((step) => step.frame?.status === "created").length,
        updated: 0,
        missing: 0,
        mismatch: steps.filter((step) => step.frame?.status === "mismatch").length,
      },
    },
    frames: steps.flatMap((step) => (step.frame === null ? [] : [step.frame.artifact])),
    files,
  };
};

// ---------------------------------------------------------------- the stories

const screenTest = "tests/screen.transition.test.tsx";
const ready: ReadonlyArray<Shown> = [
  { key: "n1", row: ada, pending: false },
  { key: "n2", row: bob, pending: false },
];
const given = (row: Row): StepPlan => ({
  kind: "Given",
  label: `given NoteAggregate acc-1/${row.NoteId}: NoteCreated ${JSON.stringify({ note: row })}`,
  world: {},
});

const renameIsRejected: Plan = {
  slug: "rename-is-rejected",
  name: "rename is rejected",
  test: { file: screenTest, name: "f(locked rename) → pending, then rolled back" },
  durationMs: 412,
  rules: dbRules,
  steps: [
    given(ada),
    given(bob),
    {
      kind: "Render",
      label: 'render <NoteList account="acc-1" />',
      world: { rows: ready, feed: "live" },
      frame: { story: "rename-is-rejected", file: "03-render.png" },
    },
    {
      kind: "When",
      label: 'when {"NoteId":"n1","title":"locked"}',
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "locked" }, pending: true }, ready[1]!],
        command: {
          name: "rename",
          input: { NoteId: "n1", title: "locked" },
          outcome: { _tag: "Pending" },
        },
        feed: "live",
      },
      frame: { story: "rename-is-rejected", file: "04-when-noteid-n1-title-locked.png" },
    },
    {
      kind: "Rejected",
      label: "rejected NoteLocked",
      world: {
        rows: ready,
        command: {
          name: "rename",
          input: { NoteId: "n1", title: "locked" },
          outcome: { _tag: "Rejected", error: { _tag: "NoteLocked" } },
        },
        feed: "live",
      },
      frame: { story: "rename-is-rejected", file: "05-rejected-notelocked.png" },
    },
  ],
  histories: [
    { tick: 1, step: 3, key: "n1", row: ada, pending: false },
    { tick: 1, step: 3, key: "n2", row: bob, pending: false },
    { tick: 2, step: 4, key: "n1", row: { NoteId: "n1", title: "locked" }, pending: true },
    { tick: 3, step: 5, key: "n1", row: ada, pending: false },
  ],
};

const renameSettles = (fails: boolean): Plan => {
  const lovelace = { NoteId: "n1", title: "Ada Lovelace" };
  const command = { name: "rename", input: lovelace };
  return {
    slug: "rename-settles",
    name: "rename settles",
    test: { file: screenTest, name: "f(rename) → pending, then committed" },
    durationMs: fails ? 388 : 352,
    rules: dbRules,
    steps: [
      given(ada),
      given(bob),
      {
        kind: "Render",
        label: 'render <NoteList account="acc-1" />',
        world: { rows: ready, feed: "live" },
        frame: { story: "rename-settles", file: "03-render.png" },
      },
      {
        kind: "When",
        label: 'when {"NoteId":"n1","title":"Ada Lovelace"}',
        world: {
          rows: [{ key: "n1", row: lovelace, pending: true }, ready[1]!],
          command: { ...command, outcome: { _tag: "Pending" } },
          feed: "live",
        },
        frame: { story: "rename-settles", file: "04-when-noteid-n1-title-ada-lovelace.png" },
      },
      {
        kind: "Settled",
        label: 'settled "Committed"',
        world: {
          rows: [{ key: "n1", row: lovelace, pending: fails }, ready[1]!],
          command: { ...command, outcome: { _tag: "Committed" } },
          feed: "live",
          ...(fails
            ? {
                broken: [
                  [
                    "nothing is pending at rest",
                    `at rest, ${list} shows n1 pending: {"NoteId":"n1","title":"Ada Lovelace"}`,
                  ],
                ] as const,
              }
            : {}),
        },
        frame: fails
          ? {
              story: "rename-settles",
              file: "05-settled-committed.png",
              status: "mismatch",
              differing: 1284,
              actual: "04-when-noteid-n1-title-ada-lovelace.png",
            }
          : { story: "rename-settles", file: "05-settled-committed.png" },
      },
      {
        kind: "Then",
        label:
          'shows notes.list({"account":"acc-1"}) [{"title":"Ada Lovelace","$hasPendingWrites":false}]',
        world: {
          rows: [{ key: "n1", row: lovelace, pending: false }, ready[1]!],
          command: { ...command, outcome: { _tag: "Committed" } },
          feed: "live",
        },
      },
    ],
    ...(fails
      ? {
          failure: {
            step: 5,
            reason:
              'After step 5 (settled "Committed"), "nothing is pending at rest" does not hold',
            detail: [
              `${list} still shows n1 pending at rest`,
              'n1 { title: "Ada Lovelace", $hasPendingWrites: true }',
              "feed NotebookChanges · acc-1 · live at #3",
              "command rename settled Committed",
            ],
          },
        }
      : {}),
    histories: [
      { tick: 1, step: 3, key: "n1", row: ada, pending: false },
      { tick: 1, step: 3, key: "n2", row: bob, pending: false },
      { tick: 2, step: 4, key: "n1", row: lovelace, pending: true },
      { tick: 3, step: 5, key: "n1", row: lovelace, pending: fails },
    ],
  };
};

const listLoads: Plan = {
  slug: "list-loads",
  name: "list loads",
  test: { file: screenTest, name: "f(query held, released) → Loading, then the notes" },
  durationMs: 301,
  rules: dbRules,
  steps: [
    given(ada),
    given(bob),
    { kind: "Hold", label: "hold the queries", world: { held: true } },
    {
      kind: "Render",
      label: 'render <NoteList account="acc-1" />',
      world: { state: "Loading", rows: [], feed: "live", held: true },
      frame: { story: "list-loads", file: "04-render.png" },
    },
    {
      kind: "Release",
      label: "release: query answers",
      world: { rows: ready, feed: "live" },
      frame: { story: "list-loads", file: "05-release-query-answers.png" },
    },
    {
      kind: "Then",
      label: 'shows notes.list({"account":"acc-1"}) [{"title":"Ada"},{"title":"Bob"}]',
      world: { rows: ready, feed: "live" },
      frame: { story: "list-loads", file: "06-then-noterows-notes-account-acc-1.png" },
    },
  ],
};

const listRetries: Plan = {
  slug: "list-retries",
  name: "list retries",
  test: {
    file: screenTest,
    name: "f(shown, feed drops with a transport error, resumes) → Retrying, then the notes",
  },
  durationMs: 355,
  rules: dbRules,
  steps: [
    given(ada),
    {
      kind: "Render",
      label: 'render <NoteList account="acc-1" />',
      world: { rows: [ready[0]!], feed: "live" },
      frame: { story: "list-retries", file: "02-render.png" },
    },
    {
      kind: "Drop",
      label: "drop the feed",
      world: { state: "Retrying", rows: [ready[0]!], feed: "dropped" },
      frame: { story: "list-retries", file: "03-drop-the-feed.png" },
    },
    {
      kind: "Then",
      label: 'state notes.list({"account":"acc-1"}) Retrying',
      world: { state: "Retrying", rows: [ready[0]!], feed: "dropped" },
      frame: { story: "list-retries", file: "04-then-noterows-notes-account-acc-1.png" },
    },
    {
      kind: "Resume",
      label: "resume the feed",
      world: { rows: [ready[0]!], feed: "live" },
      frame: { story: "list-retries", file: "05-resume-the-feed.png" },
    },
    {
      kind: "Then",
      label: 'state notes.list({"account":"acc-1"}) Ready',
      world: { rows: [ready[0]!], feed: "live" },
      frame: { story: "list-retries", file: "06-then-noterows-notes-account-acc-1.png" },
    },
  ],
};

const inlineRename = (status: "created" | "matched"): Plan => ({
  slug: "inline-rename-field",
  name: "inline rename field",
  test: { file: screenTest, name: "f(click title, type, enter) → field, then pending" },
  durationMs: 467,
  rules: dbRules,
  steps: [
    given(ada),
    given(bob),
    {
      kind: "Render",
      label: 'render <NoteList account="acc-1" editable />',
      world: { rows: ready, feed: "live" },
      frame: { story: "rename-settles", file: "03-render.png", status },
    },
    {
      kind: "Send",
      label: "editor: send Edit",
      world: {
        rows: ready,
        feed: "live",
        machine: { state: "Editing", context: { NoteId: "n1", draft: "Ada L" } },
      },
      frame: { story: "rename-is-rejected", file: "03-render.png", status },
    },
    {
      kind: "Send",
      label: "editor: send Save",
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada L" }, pending: true }, ready[1]!],
        command: {
          name: "rename",
          input: { NoteId: "n1", title: "Ada L" },
          outcome: { _tag: "Pending" },
        },
        feed: "live",
        machine: { state: "Saving", context: { NoteId: "n1", draft: "Ada L" } },
      },
      frame: { story: "rename-settles", file: "04-when-noteid-n1-title-ada-lovelace.png", status },
    },
    {
      kind: "Settled",
      label: 'settled "Committed"',
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada L" }, pending: false }, ready[1]!],
        command: {
          name: "rename",
          input: { NoteId: "n1", title: "Ada L" },
          outcome: { _tag: "Committed" },
        },
        feed: "live",
        machine: { state: "Saved", context: { NoteId: "n1", draft: "Ada L" } },
      },
    },
  ],
});

const editorSaves: Plan = {
  slug: "editor-saves",
  name: "editor saves",
  test: {
    file: screenTest,
    name: "f(running editor, frames only where asked) → shot steps beside machine steps",
  },
  durationMs: 520,
  rules: [],
  steps: [
    given(ada),
    {
      kind: "Open",
      label: 'open notes.list({"account":"acc-1"})',
      world: { rows: [ready[0]!], feed: "live" },
    },
    {
      kind: "Render",
      label: 'render <Editor NoteId="n1" />',
      world: { rows: [ready[0]!], feed: "live" },
    },
    {
      kind: "Start",
      label: "start editor running",
      world: {
        rows: [ready[0]!],
        feed: "live",
        machine: { state: "Idle", context: { NoteId: "n1", draft: "Ada" } },
      },
    },
    {
      kind: "Send",
      label: "editor: send Edit",
      world: {
        rows: [ready[0]!],
        feed: "live",
        machine: { state: "Editing", context: { NoteId: "n1", draft: "Ada 2" } },
      },
    },
    {
      kind: "Shot",
      label: "shot saving",
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada 2" }, pending: true }],
        command: {
          name: "rename",
          input: { NoteId: "n1", title: "Ada 2" },
          outcome: { _tag: "Pending" },
        },
        feed: "live",
        machine: { state: "Saving", context: { NoteId: "n1", draft: "Ada 2" } },
      },
      frame: { story: "editor-saves", file: "06-saving.png" },
    },
    {
      kind: "Send",
      label: "editor: send Save",
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada 2" }, pending: true }],
        command: {
          name: "rename",
          input: { NoteId: "n1", title: "Ada 2" },
          outcome: { _tag: "Pending" },
        },
        feed: "live",
        machine: { state: "Saving", context: { NoteId: "n1", draft: "Ada 2" } },
      },
    },
    {
      kind: "Settled",
      label: 'settled "Committed"',
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada 2" }, pending: false }],
        command: {
          name: "rename",
          input: { NoteId: "n1", title: "Ada 2" },
          outcome: { _tag: "Committed" },
        },
        feed: "live",
        machine: { state: "Saved", context: { NoteId: "n1", draft: "Ada 2" } },
      },
    },
    {
      kind: "Shot",
      label: "shot saved",
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada 2" }, pending: false }],
        command: {
          name: "rename",
          input: { NoteId: "n1", title: "Ada 2" },
          outcome: { _tag: "Committed" },
        },
        feed: "live",
        machine: { state: "Saved", context: { NoteId: "n1", draft: "Ada 2" } },
      },
      frame: { story: "editor-saves", file: "09-saved.png" },
    },
  ],
};

const twoClients: Plan = {
  slug: "two-clients-agree",
  name: "two clients agree",
  test: {
    file: "tests/story.transition.test.ts",
    name: "f(remote rename) → both scopes show it, settled",
  },
  durationMs: 144,
  rules: dbRules,
  steps: [
    given(ada),
    {
      kind: "Open",
      label: 'open notes.list({"account":"acc-1"})',
      world: { rows: [ready[0]!], feed: "live" },
    },
    {
      kind: "Remote",
      label: 'remote NoteAggregate acc-1/n1: RenameNote {"title":"Ada 2"}',
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada 2" }, pending: false }],
        feed: "live",
      },
    },
    {
      kind: "Then",
      label: 'shows notes.list({"account":"acc-1"}) [{"title":"Ada 2"}]',
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada 2" }, pending: false }],
        feed: "live",
      },
    },
    {
      kind: "Settle",
      label: "settle",
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada 2" }, pending: false }],
        feed: "live",
      },
    },
  ],
};

const exploreMoves = [
  'edit.step("Ada 2")',
  "save.step()",
  "drop.step()",
  "remote.step()",
  "resume.step()",
];
const noteLifecycle = (fails: boolean): Plan => ({
  slug: "note-lifecycle",
  name: "note lifecycle",
  test: { file: "tests/explore.transition.test.ts", name: "note lifecycle" },
  durationMs: 4210,
  rules: dbRules,
  steps: [
    given(ada),
    {
      kind: "Open",
      label: 'open notes.list({"account":"acc-1"})',
      world: { rows: [ready[0]!], feed: "live" },
    },
    {
      kind: "Start",
      label: "start editor running",
      world: {
        rows: [ready[0]!],
        feed: "live",
        machine: { state: "Idle", context: { NoteId: "n1" } },
      },
    },
    {
      kind: "Send",
      label: "editor: send Edit",
      world: {
        rows: [ready[0]!],
        feed: "live",
        machine: { state: "Editing", context: { NoteId: "n1", draft: "Ada 2" } },
      },
    },
    {
      kind: "Send",
      label: "editor: send Save",
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada 2" }, pending: true }],
        command: {
          name: "rename",
          input: { NoteId: "n1", title: "Ada 2" },
          outcome: { _tag: "Pending" },
        },
        feed: "live",
      },
    },
    {
      kind: "Drop",
      label: "drop the feed",
      world: {
        state: "Retrying",
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada 2" }, pending: true }],
        command: {
          name: "rename",
          input: { NoteId: "n1", title: "Ada 2" },
          outcome: { _tag: "Pending" },
        },
        feed: "dropped",
      },
    },
    {
      kind: "Remote",
      label: 'remote NoteAggregate acc-1/n1: RenameNote {"title":"Ada (theirs)"}',
      world: {
        rows: [{ key: "n1", row: ada, pending: false }],
        command: {
          name: "rename",
          input: { NoteId: "n1", title: "Ada 2" },
          outcome: { _tag: "Pending" },
        },
        feed: "dropped",
        ...(fails
          ? {
              broken: [
                [
                  "the clients' own rules hold",
                  `"a row never flickers back": ${list} showed n1 older than a row it already showed`,
                ],
              ] as const,
            }
          : {}),
      },
    },
    {
      kind: "Resume",
      label: "resume the feed",
      world: {
        rows: [{ key: "n1", row: { NoteId: "n1", title: "Ada (theirs)" }, pending: false }],
        feed: "live",
      },
    },
  ],
  ...(fails
    ? {
        failure: {
          step: 7,
          reason: `After step 7 (remote NoteAggregate acc-1/n1: RenameNote), "the clients' own rules hold" does not hold`,
          detail: [
            `${list} showed n1 older than a row it already showed`,
            'n1: "Ada" (#1) → "Ada 2" (pending) → "Ada" (#1) → "Ada (theirs)" (#3)',
          ],
        },
        explore: {
          name: "note lifecycle",
          level: "checked",
          index: 3,
          of: 64,
          moves: ['edit.step("Ada 2")', "drop.step()", "remote.step()"],
          shrunkFrom: exploreMoves,
        },
      }
    : {}),
  histories: [
    { tick: 1, step: 2, key: "n1", row: ada, pending: false },
    { tick: 2, step: 5, key: "n1", row: { NoteId: "n1", title: "Ada 2" }, pending: true },
    { tick: 3, step: 7, key: "n1", row: ada, pending: false },
    { tick: 4, step: 8, key: "n1", row: { NoteId: "n1", title: "Ada (theirs)" }, pending: false },
  ],
});

/** The stories CI recorded on a run at `moment` of pull request #57 (or its base on main). */
export const storiesOf = (run: string, moment: Moment): ReadonlyArray<SeedStory> => {
  const plans: Array<Plan> = [
    renameSettles(moment === "settle" || moment === "pending"),
    renameIsRejected,
    listLoads,
    listRetries,
    ...(moment === "base" ? [] : [inlineRename(moment === "field" ? "created" : "matched")]),
    editorSaves,
    twoClients,
    noteLifecycle(moment === "debounce" || moment === "pending"),
  ];
  return plans.map((plan) => build(run, plan));
};
