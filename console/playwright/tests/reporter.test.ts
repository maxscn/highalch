import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { describe, expect, it } from "vite-plus/test";
import { Results } from "@highalch/console-client";
import { ConsoleReporter, Convert } from "../src/index.ts";
import { png, withConsole } from "./support.ts";

describe("ConsoleReporter offline and failure handling", () => {
  const config = {
    rootDir: "/repo",
    version: "1.63.0",
    projects: [{ name: "webkit", use: { browserName: "webkit" } }],
  } as unknown as FullConfig;
  const testCase = {
    id: "t1",
    title: "works",
    titlePath: () => ["", "webkit", "a.spec.ts", "works"],
    location: { file: "/repo/a.spec.ts", line: 2, column: 3 },
    tags: [],
    annotations: [],
    expectedStatus: "passed",
    outcome: () => "expected",
    parent: { project: () => ({ name: "webkit", use: { browserName: "webkit" } }) },
  } as unknown as TestCase;
  const result = {
    retry: 0,
    status: "passed",
    startTime: new Date("2026-09-22T10:00:00.000Z"),
    duration: 12,
    workerIndex: 0,
    errors: [],
    stdout: [],
    stderr: [],
    steps: [],
    attachments: [{ name: "screenshot", contentType: "image/png", body: png([0, 255, 0]) }],
  } as unknown as TestResult;
  const end = {
    status: "passed",
    startTime: new Date("2026-09-22T10:00:00.000Z"),
    duration: 20,
  } as FullResult;

  it("writes the results objects to .highalch/ without a URL", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "highalch-pw-local-"));
    const reporter = new ConsoleReporter({
      project: "crm",
      commit: "abcdef0",
      branch: "main",
      cwd,
      env: {},
      log: () => {},
    });
    reporter.onBegin(config, {} as Suite);
    reporter.onTestEnd(testCase, result);
    await reporter.onEnd(end);
    const reported = reporter.reported;
    if (reported?.status !== "written") throw new Error(JSON.stringify(reported));
    const files = await readdir(join(reported.dir, "results"));
    expect(files).toEqual(["0001.tests.json"]);
    const body = JSON.parse(
      await readFile(join(reported.dir, "results", files[0] ?? ""), "utf8"),
    ) as Array<Results.TestItem>;
    expect(body).toMatchObject([
      { id: "t1", file: "a.spec.ts", status: "passed", browser: "webkit", titlePath: [] },
    ]);
    expect(await readdir(join(reported.dir, "artifacts"))).toHaveLength(1);
  });

  it("does not fail the run when reporting fails, unless strict", () =>
    withConsole(async (local) => {
      const base = {
        commit: "abcdef0",
        branch: "main",
        url: local.url,
        apiKey: `${local.apiKey.slice(0, -4)}xxxx`,
        env: {},
        log: () => {},
      };
      const lenient = new ConsoleReporter(base);
      lenient.onBegin(config, {} as Suite);
      lenient.onTestEnd(testCase, result);
      expect(await lenient.onEnd(end)).toBeUndefined();
      expect(lenient.reported).toMatchObject({
        status: "failed",
        error: { _tag: "ApiKeyInvalid" },
      });
      const strict = new ConsoleReporter({ ...base, strict: true });
      strict.onBegin(config, {} as Suite);
      expect(await strict.onEnd(end)).toEqual({ status: "failed" });
    }));

  it("classifies attachment kinds", () => {
    const kind = (name: string, contentType = "image/png") => Convert.kind({ name, contentType });
    expect(kind("screenshot")).toBe("screenshot");
    expect(kind("video", "video/webm")).toBe("video");
    expect(kind("trace", "application/zip")).toBe("trace");
    expect(kind("home-expected.png")).toBe("snapshot-expected");
    expect(kind("home-actual.png")).toBe("snapshot-actual");
    expect(kind("home-diff.png")).toBe("snapshot-diff");
    expect(kind("log", "text/plain")).toBe("other");
    expect(Results.AttachmentKind.literals).toContain(kind("x"));
  });
});

describe("subject annotations", () => {
  it("maps highalch:component, highalch:part and highalch:page annotations to the test's subject", async () => {
    const { subjectOf } = await import("../src/convert.ts");
    expect(subjectOf([{ type: "highalch:page", description: " checkout " }])).toEqual({
      subject: { kind: "page", name: "checkout" },
    });
    expect(
      subjectOf([
        { type: "issue", description: "x" },
        { type: "highalch:component", description: "customer/CustomerCard" },
        { type: "highalch:part", description: "ignored" },
      ]),
    ).toEqual({ subject: { kind: "component", name: "customer/CustomerCard" } });
    expect(subjectOf([{ type: "highalch:part" }])).toEqual({});
    expect(subjectOf([])).toEqual({});
  });
});
