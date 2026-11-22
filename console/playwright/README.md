# @highalch/console-playwright

Playwright reporter that uploads a run to HighAlch Console with `@highalch/console-client` (same
credentials, CI detection and offline `.highalch/` mode as the fuzz reporter): attachments as
artifacts, tests as `Results.TestItem` objects of a `playwright` run.

```ts
// playwright.config.ts
export default defineConfig({
  // HIGHALCH_URL and HIGHALCH_API_KEY (or GitHub Actions OIDC) in the environment
  reporter: [["list"], ["@highalch/console-playwright"]],
});
```

Options: every `@highalch/console-client` option (`project`, `url`, `apiKey`, `commit`, `branch`, `pr`,
`source`, `dir`, …) plus `strict` (fail the Playwright run when reporting fails; default false)
and `log`.

Reported per test: id, title, describe path, file/line/column, project and browser, status
(`passed | failed | flaky | skipped`), expected status, duration, retries, tags, annotations, and
per attempt: status, start, duration, worker, errors (message, stack, location, code-frame
snippet; ANSI stripped), nested steps with durations, stdout/stderr, and attachments uploaded as
artifacts — `screenshot`, `video`, `trace`, `snapshot-expected`, `snapshot-actual`,
`snapshot-diff`, or `other`.

A test can name its subject (what it exercises) with an annotation; the server follows the
subject across runs and compares the last attempt's screenshots with the baseline run:

```ts
test(
  "customer card",
  { annotation: { type: "highalch:component", description: "customer/CustomerCard" } },
  async ({ page }) => {
    /* … */
  },
);
// also "highalch:part" and "highalch:page"
```

```ts
export class ConsoleReporter implements Reporter {
  constructor(options?: ConsoleReporterOptions);
  reported?: Reported;
}
export default ConsoleReporter;
export namespace Convert {
  test;
  kind;
  plain;
  subjectOf;
} // pure conversion helpers
```
