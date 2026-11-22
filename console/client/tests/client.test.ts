import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { open, Results, uploadStories, type Options } from "../src/index.ts";
import { serve, type LocalConsole } from "../src/testing.ts";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer)));

let scope: Scope.Closeable;
let local: LocalConsole;

beforeAll(async () => {
  scope = await Effect.runPromise(Scope.make());
  local = await Effect.runPromise(
    serve({
      oidc: {
        "gh-token": { repository: "acme/crm", sha: "c0ffee0c0ffee0", ref: "refs/heads/main" },
      },
    }).pipe(Scope.provide(scope)),
  );
}, 30_000);

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

const base = () => ({
  url: local.url,
  apiKey: local.apiKey,
  commit: "abcdef0",
  branch: "main",
  pr: null,
  env: {},
  retry: { attempts: 2, delay: 1 },
});

/** The options without a URL and/or API key. */
const without = (...keys: ReadonlyArray<"url" | "apiKey">): Options => {
  const options: Record<string, unknown> = { ...base() };
  for (const key of keys) delete options[key];
  return options as Options;
};

const caseItem = (index: number, artifactId?: string): Results.CaseItem => ({
  name: "Customer",
  subject: { kind: "component", name: "CustomerCard" },
  schemaHash: "s1:x",
  case: {
    id: `7:${index}`,
    index,
    seed: 7,
    path: String(index),
    value: { name: "x".repeat(200) },
    edges: [],
    outcome: index === 0 ? "crash" : "ok",
    ...(artifactId ? { capture: { artifactId, kind: "html" as const } } : {}),
  },
});

/** The run as its organisation's owner reads it, once its status is `status`. */
const runOf = (id: string, status: "running" | "completed" = "completed") =>
  Effect.runPromise(
    local
      .asOwner((api, options) => api.RunById({ run: RunId.make(id) }, options))
      .pipe(
        Effect.filterOrFail((row) => row?.status === status),
        Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }),
      ),
  );

describe("upload flow against a local HighAlch Console", () => {
  it("opens, uploads deduplicated artifacts and results objects, completes", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const upload = yield* open(base(), "fuzz");
        const ids = yield* upload.artifacts([
          { name: "a.html", mime: "text/html", body: "<p>a</p>" },
          { name: "b.html", mime: "text/html", body: "<p>a</p>" },
          { name: "c.png", mime: "image/png", body: new Uint8Array([1, 2, 3]) },
        ]);
        expect(ids[0]).toBe(ids[1]);
        expect(ids[2]).not.toBe(ids[0]);
        // 6 000 cases of ~300 bytes: two objects
        yield* upload.results({
          cases: Array.from({ length: 6_000 }, (_, i) => caseItem(i, i === 0 ? ids[0] : undefined)),
        });
        return yield* upload.complete();
      }),
    );
    expect(outcome.mode).toBe("remote");
    const detail = await runOf(outcome.runId);
    expect(detail).toMatchObject({ status: "completed", kind: "fuzz", project: local.project });
    const bodies = [...local.objects.entries()];
    expect(bodies.filter(([key]) => key.startsWith(`a/${local.org}/`))).toHaveLength(2);
    const parts = bodies.filter(([key]) => key.startsWith(`r/${local.org}/${outcome.runId}/`));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const items = parts.flatMap(([key, { body }]) =>
      key.endsWith(".cases.json")
        ? (JSON.parse(new TextDecoder().decode(body)) as Array<unknown>)
        : [],
    );
    expect(items).toHaveLength(6_000);
  });

  it("uploads a folder of story reports with their frames", async () => {
    const folder = await mkdtemp(join(tmpdir(), "highalch-stories-"));
    await mkdir(join(folder, "rename-settles"));
    const frame = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    await writeFile(join(folder, "rename-settles", "01-render.png"), frame);
    await writeFile(
      join(folder, "rename-settles", "story.json"),
      JSON.stringify({
        format: "highalch.story/1",
        name: "rename settles",
        slug: "rename-settles",
        status: "passed",
        durationMs: 12,
        host: "memory",
        scope: "acc-1",
        clock: "manual",
        rules: [{ name: "nothing is pending at rest", at: "rest" }],
        steps: [
          {
            n: 1,
            kind: "Given",
            label: "a note",
            status: "passed",
            durationMs: 1,
            world: {},
            rules: [{ name: "nothing is pending at rest", at: "rest", held: true }],
          },
          {
            n: 2,
            kind: "Render",
            label: "the list",
            status: "passed",
            frame: { file: "01-render.png", status: "created", sha256: "ab".repeat(32) },
            rules: [],
          },
        ],
        histories: [],
        feeds: [],
      }),
    );
    const { outcome, stories } = await run(uploadStories({ ...base(), folder }));
    expect(stories).toBe(1);
    expect(await runOf(outcome.runId)).toMatchObject({
      kind: "stories",
      summary: { stories: { passed: 1, failed: 0, frames: { created: 1 } } },
    });
    const found = await Effect.runPromise(
      local.asOwner((api, options) => api.Stories({ run: RunId.make(outcome.runId) }, options)),
    );
    expect(found).toMatchObject({
      entries: [
        {
          slug: "rename-settles",
          steps: { passed: 2, failed: 0, notRun: 0 },
          kinds: ["Given", "Render"],
        },
      ],
    });
  });

  // HighAlch writes these reports once story reports land in `@highalch/story`
  // (`Report.files`); until then the reports are written here as it would write them.
  it("uploads a failed story's failure, rules and the steps it did not run", async () => {
    const folder = await mkdtemp(join(tmpdir(), "highalch-reports-"));
    const report = (slug: string, fields: Record<string, unknown>) =>
      mkdir(join(folder, slug)).then(() =>
        writeFile(
          join(folder, slug, "story.json"),
          JSON.stringify({
            format: "highalch.story/1",
            slug,
            durationMs: 3,
            host: "custom",
            scope: "acc-1",
            clock: "manual",
            histories: [],
            feeds: [],
            ...fields,
          }),
        ),
      );
    const kept = { name: "the scope stays acc-1", at: "step" };
    await report("a-story-that-passes", {
      name: "a story that passes",
      status: "passed",
      rules: [kept],
      steps: [
        { n: 1, kind: "Settle", label: "settle", status: "passed", world: {}, rules: [] },
        {
          n: 2,
          kind: "Check",
          label: "check the wire is quiet",
          status: "passed",
          world: {},
          rules: [{ ...kept, held: true }],
        },
      ],
      end: { rules: [] },
    });
    await report("a-story-that-fails", {
      name: "a story that fails",
      status: "failed",
      rules: [],
      failure: {
        step: 2,
        reason: "Step 2 (check it fails) failed: expected a note",
        detail: ["expected a note"],
      },
      steps: [
        { n: 1, kind: "Settle", label: "settle", status: "passed", world: {}, rules: [] },
        { n: 2, kind: "Check", label: "check it fails", status: "failed", world: {}, rules: [] },
        { n: 3, kind: "Settle", label: "settle", status: "not-run", rules: [] },
      ],
    });

    const { outcome, stories } = await run(uploadStories({ ...base(), folder }));
    expect(stories).toBe(2);
    expect(await runOf(outcome.runId)).toMatchObject({
      kind: "stories",
      summary: { stories: { passed: 1, failed: 1 } },
    });
    const found = await Effect.runPromise(
      local.asOwner((api, options) => api.Stories({ run: RunId.make(outcome.runId) }, options)),
    );
    expect(found.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: "a-story-that-passes",
          name: "a story that passes",
          status: "passed",
          host: "custom",
          scope: "acc-1",
          invariants: ["the scope stays acc-1"],
          steps: { passed: 2, failed: 0, notRun: 0 },
          kinds: ["Settle", "Check"],
        }),
        expect.objectContaining({
          slug: "a-story-that-fails",
          status: "failed",
          failure: { step: 2, reason: "Step 2 (check it fails) failed: expected a note" },
          steps: { passed: 1, failed: 1, notRun: 1 },
        }),
      ]),
    );
  });

  it("authenticates with a GitHub Actions ID token for audience highalch", async () => {
    const asked: Array<string> = [];
    const actions = "https://actions.test/token";
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(actions)) return globalThis.fetch(input, init);
      asked.push(url);
      return Promise.resolve(Response.json({ value: "gh-token" }));
    };
    const outcome = await run(
      Effect.gen(function* () {
        const upload = yield* open(
          {
            ...without("apiKey"),
            fetch,
            env: { ACTIONS_ID_TOKEN_REQUEST_URL: actions, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req" },
          },
          "playwright",
        );
        return yield* upload.complete();
      }),
    );
    expect(asked[0]).toContain("audience=highalch");
    expect(await runOf(outcome.runId)).toMatchObject({ commit: "c0ffee0c0ffee0" });
  });

  it("fails with the domain's own error for a revoked or unknown key", async () => {
    const failure = await run(
      Effect.flip(open({ ...base(), apiKey: `${local.apiKey.slice(0, -4)}xxxx` }, "fuzz")),
    );
    expect(failure._tag).toBe("ApiKeyInvalid");
  });

  it("refuses a configured project the credential is not bound to", async () => {
    const failure = await run(Effect.flip(open({ ...base(), project: "other" }, "fuzz")));
    expect(failure).toMatchObject({ _tag: "ProjectMismatch", credential: local.project });
  });

  it("answers ServerUnreachable when nothing listens", async () => {
    const failure = await run(Effect.flip(open({ ...base(), url: "http://127.0.0.1:9" }, "fuzz")));
    expect(failure._tag).toBe("ServerUnreachable");
  });
});

describe("offline", () => {
  it("writes the same payloads to .highalch/ without a URL", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "highalch-local-"));
    const outcome = await run(
      Effect.gen(function* () {
        const upload = yield* open({ ...without("url"), project: "crm", cwd }, "fuzz");
        yield* upload.artifacts([{ name: "a.html", mime: "text/html", body: "<p>a</p>" }]);
        yield* upload.results({ cases: [caseItem(0)] });
        return yield* upload.complete();
      }),
    );
    if (outcome.mode !== "local") throw new Error("expected local");
    expect(outcome.reason).toBe("no-url");
    expect(outcome.dir.startsWith(join(cwd, ".highalch", "runs"))).toBe(true);
    expect(await readdir(join(outcome.dir, "results"))).toEqual(["0001.cases.json"]);
    expect(JSON.parse(await readFile(join(outcome.dir, "open.json"), "utf8"))).toMatchObject({
      project: "crm",
      kind: "fuzz",
    });
  });

  it("needs a project offline", async () => {
    const failure = await run(Effect.flip(open(without("url", "apiKey"), "fuzz")));
    expect(failure).toMatchObject({ _tag: "SettingMissing", setting: "HIGHALCH_PROJECT" });
  });
});
