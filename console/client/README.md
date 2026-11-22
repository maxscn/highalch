# @highalch/console-client

HighAlch Console's CI client: `ConsoleApi` (the domain's one Api) over HTTP, authenticated with a
project API key or a GitHub Actions OIDC token, and the upload flow the domain defines. The
Playwright reporter, the fuzz reporter and the story uploader are built on it.

```ts
import { open, uploadStories } from "@highalch/console-client";

const upload = yield * open({}, "playwright"); // Effect; needs NodeServices and a Scope
const ids = yield * upload.artifacts([{ name: "a.png", mime: "image/png", body }]);
yield * upload.results({ tests }); // Results.TestItem / CaseItem / TraceItem
yield * upload.stories(reports); // story.json + frames (src/StoryReport.ts)
const outcome = yield * upload.complete(); // { mode: "remote", runId, org } | { mode: "local", … }

yield * uploadStories({ folder: "artifacts/stories" }); // every <slug>/story.json as one run
```

The flow: `Credential` (the credential's organisation and project) → `OpenRun` →
`DeclareArtifacts` / `RecordResults` (receipts) → `UploadLinks` at least at the receipt → PUT each
body with the link's headers (a `null` link: the body is already stored; a 403: one fresh link) →
`RecordStory` → `CompleteRun`. Results are packed into JSON objects of at most 1 MB, three per
`RecordResults`. Requests are retried on network failures, 429 and 5xx (exponential, jittered,
`Retry-After` honoured).

## Settings (each option falls back to the environment)

| Option                                                        | Env / default                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `url`                                                         | `HIGHALCH_URL`; without it the run is written to `<dir>/runs/<runId>/`                 |
| `apiKey`                                                      | `HIGHALCH_API_KEY` (`highalch_live_…`), else GitHub Actions OIDC (audience `highalch`) |
| `project`                                                     | `HIGHALCH_PROJECT`, else the key's project; must match the credential's project        |
| `commit`, `branch`, `pr`, `source`, `baseBranch`              | detected (GitHub Actions, GitLab CI, CircleCI, Buildkite, `git`)                       |
| `dir`                                                         | `.highalch` (offline output, relative to `cwd`)                                        |
| `cwd`, `env`, `fetch`, `retry: { attempts = 4, delay = 250 }` | injection points                                                                       |

## Errors

The client's own, one per reason: `SettingMissing`, `OidcTokenUnavailable`, `ServerUnreachable`,
`RateLimited`, `UnexpectedResponse`, `UploadRefused`, `ItemTooLarge`, `InvalidItem`,
`ReportUnreadable`, `ReportInvalid`, `WriteFailed`, `ProjectMismatch`. What HighAlch Console
refuses arrives as the domain's own error (`ApiKeyInvalid`, `NotEntitled`, `QuotaExceeded`, …).

## Testing (`@highalch/console-client/testing`)

`serve()` hosts the real domain in memory behind `ConsoleApi` over HTTP on a free port, with an
object store whose links check size, type and SHA-256, seeded with a paid organisation, a project
bound to `acme/crm` and an API key. The reporters' tests run against it.
