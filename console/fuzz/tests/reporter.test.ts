import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Results } from "@highalch/console-client";
import { serve, type LocalConsole } from "@highalch/console-client/testing";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import { Console, Fuzz } from "../src/index.ts";

const subject = { kind: "component", name: "test" } as const;

const sha = "0123456789abcdef0123456789abcdef01234567";
const schema: Fuzz.JsonSchema<{ name: string }> = {
  title: "Customer",
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};
const html = (value: unknown): Fuzz.Capture => ({
  kind: "html",
  mime: "text/html",
  body: `<p>${JSON.stringify(value)}</p>`,
  meta: {},
});
const silent = () => {};

const collect = async (report: Console.Reporter) => {
  for (const c of Fuzz.cases(schema, { subject, seed: 11, count: 30 }))
    report.add(c, html(c.value), { state: { customer: c.value } });
  report.trace(
    await Fuzz.run({
      name: "counter",
      subject: { kind: "part", name: "counter" },
      seed: 1,
      steps: 5,
      runs: 5,
      initial: 0,
      actions: { enum: [1, -1] },
      step: (state: number, action: number) => state + action,
      capture: (state) => html(state),
    }),
  );
};

let scope: Scope.Closeable;
let local: LocalConsole;

beforeAll(async () => {
  scope = await Effect.runPromise(Scope.make());
  local = await Effect.runPromise(serve().pipe(Scope.provide(scope)));
}, 30_000);

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

const decoder = new TextDecoder();

/** The items of every results object of a run of `part`, as stored. */
const itemsOf = <A>(run: string, part: string) =>
  [...local.objects.entries()]
    .filter(([key]) => key.startsWith(`r/${local.org}/${run}/`) && key.endsWith(`.${part}.json`))
    .flatMap(([, { body }]) => JSON.parse(decoder.decode(body)) as Array<A>);

describe("Console.reporter", () => {
  it("uploads cases, captures and traces as a fuzz run", async () => {
    const report = Console.reporter({
      commit: sha,
      branch: "main",
      url: local.url,
      apiKey: local.apiKey,
      env: {},
      log: silent,
    });
    await collect(report);
    const flushed = await report.flush();
    if (flushed.status !== "uploaded") throw new Error(JSON.stringify(flushed));
    const run = await Effect.runPromise(
      local.asOwner((api, options) => api.RunById({ run: RunId.make(flushed.runId) }, options)),
    );
    expect(run).toMatchObject({ kind: "fuzz", project: local.project, commit: sha });
    const cases = itemsOf<Results.CaseItem>(flushed.runId, "cases");
    expect(cases).toHaveLength(30);
    const artifacts = JSON.stringify(
      await Effect.runPromise(
        local.asOwner((api, options) => api.Artifacts({ run: RunId.make(flushed.runId) }, options)),
      ),
    );
    expect(
      cases.every(
        (c) => c.case.capture?.kind === "html" && artifacts.includes(c.case.capture.artifactId),
      ),
    ).toBe(true);
    expect(cases[0]?.case.state).toEqual({ customer: cases[0]?.case.value });
    const trace = itemsOf<Results.TraceItem>(flushed.runId, "traces")[0];
    expect(trace?.steps).toHaveLength(5);
    expect(trace?.steps.every((step) => step.captureArtifactId !== undefined)).toBe(true);
    expect(await report.flush()).toEqual({ status: "empty" });
  });

  it("reports a refusal as a typed failure without throwing, unless strict", async () => {
    const logs: Array<string> = [];
    const apiKey = `${local.apiKey.slice(0, -4)}xxxx`;
    const options = {
      commit: sha,
      branch: "main",
      url: local.url,
      apiKey,
      env: {},
      log: (line: string) => logs.push(line),
    };
    const report = Console.reporter(options);
    await collect(report);
    const flushed = await report.flush();
    expect(flushed).toMatchObject({ status: "failed", error: { _tag: "ApiKeyInvalid" } });
    expect(logs.join("\n")).toContain("[highalch] results not reported (ApiKeyInvalid)");
    expect(logs.join("\n")).not.toContain(apiKey);

    const strict = Console.reporter({ ...options, strict: true });
    await collect(strict);
    await expect(strict.flush()).rejects.toMatchObject({ _tag: "ApiKeyInvalid" });
  });

  it("writes the same objects to .highalch/ without a URL", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "highalch-fuzz-"));
    const report = Console.reporter({
      project: "crm",
      commit: sha,
      branch: "main",
      cwd,
      env: {},
      log: silent,
    });
    await collect(report);
    const flushed = await report.flush();
    if (flushed.status !== "written") throw new Error(JSON.stringify(flushed));
    expect(flushed.dir.startsWith(join(cwd, ".highalch", "runs"))).toBe(true);
    const files = await readdir(join(flushed.dir, "results"));
    const cases = (
      await Promise.all(
        files
          .filter((file) => file.endsWith(".cases.json"))
          .map(
            async (file) =>
              JSON.parse(
                await readFile(join(flushed.dir, "results", file), "utf8"),
              ) as Array<Results.CaseItem>,
          ),
      )
    ).flat();
    expect(cases).toHaveLength(30);
    const artifacts = await readdir(join(flushed.dir, "artifacts"));
    expect(artifacts.every((file) => file.endsWith(".html"))).toBe(true);
    expect(artifacts).toContain(`${cases[0]?.case.capture?.artifactId.replace("local-", "")}.html`);
  });

  it("is exported from the reporter subpath too", async () => {
    const sub = await import("../src/reporter.ts");
    expect(sub.reporter).toBe(Console.reporter);
  });
});
