# HighAlch Console

The platform that hosts HighAlch stories. CI uploads story reports, Playwright runs and fuzzing
results, tied to a commit and optionally a pull request; the Console shows them, live. It is built
on HighAlch itself: its reads are LowAlch `Rows` synced into TanStack DB, its writes are Domain
commands, and its screens are tested with HighAlch screen stories.

Every package here is private: none is published, none is in the Changesets release group.

| Folder                     | Package                                    | What it is                                                                                                                                       |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`domain`](domain)         | `@highalch/console-domain`                 | The alchemy Domain: aggregates, commands, policies, LowAlch Rows and the `ConsoleApi` every browser and CI client talks to. Tested with stories. |
| [`client`](client)         | `@highalch/console-client`                 | The CI client over `ConsoleApi`: API key or GitHub Actions OIDC, the upload flow, retries, the story uploader, an offline `.highalch/` writer.   |
| [`fuzz`](fuzz)             | `@highalch/console-fuzz`                   | Seeded fuzzing over fast-check: JSON Schema arbitraries, edge tagging, action traces, capture adapters (React, Playwright), `Console.reporter`.  |
| [`playwright`](playwright) | `@highalch/console-playwright`             | `ConsoleReporter`, a Playwright reporter that uploads runs (tests, retries, steps, screenshots, videos, traces, snapshot diffs).                 |
| [`server`](server)         | `@highalch/console-server`                 | The Cloudflare Worker (alchemy): hosts the Domain, Better Auth, Stripe, R2 signed links and rate limits. No behaviour of its own.                |
| [`web`](web)               | `@highalch/console-web`                    | The web app: TanStack Start, React, Tailwind with shadcn on Base UI, data through `@lowalch/tanstack-db`, screens tested with screen stories.    |
| [`example`](example)       | `@highalch/console-example-crm-transition` | Template for CRM-style `f(state, action) => next state` transition tests reported to the Console.                                                |

Decisions and the migration plan are in [docs/migration.md](docs/migration.md).

## Story reports

The Console decodes `story.json` with its own copy of the format,
`@highalch/console-client/StoryReport`, because story reports are not in `@highalch/story` yet.
Once they are, the copy goes and the Console decodes with `@highalch/story/report`.

## Development

From the repository root:

```bash
vp install
vp check                  # format, lint, type-aware lint (the Console included)
vp run check:patterns     # import boundaries, the Console's included
vp run typecheck          # tsc over the libraries and each Console project
vp test --maxWorkers=2    # the libraries' tests and the Console's unit and story tests
vp run test:console-e2e   # the Console's end-to-end tests (below)
```

Web app against an in-memory Console with seeded data (port 5201):

```bash
cd console/web && vp run dev
```

The seed comes from real Playwright and fuzz runs (`web/dev/runs`, written to `web/.seed`, both
ignored by git): `vp run dev` generates it when it is missing, `vp run seed` regenerates it. It
needs Playwright's Chromium in the local browser cache (`playwright install chromium`).

Worker locally (port 4810, nothing deployed):

```bash
cd console/server && vp run dev
```

Set `HIGHALCH_URL` and `HIGHALCH_API_KEY` (or run in GitHub Actions with `id-token: write`) for
the reporters to upload instead of writing to `.highalch/`.

## End-to-end tests

`vp test` leaves out the Console's `*.e2e.test.*` files. `vp run test:console-e2e` generates the
web seed if it is missing, then runs them (`HIGHALCH_CONSOLE_E2E=1`), one file at a time:

- `server/tests/worker.e2e.test.ts`: the Worker under `alchemy dev --stage local` (workerd, local
  R2, no account touched), signed up through Better Auth, paid through a signed Stripe event, fed
  by a real Playwright run and a folder of story reports. About two minutes.
- `playwright/tests/reporter.e2e.test.ts`: a real Playwright run reporting to a local Console.
- `web/tests/screens.e2e.test.tsx` and `web/tests/seed.e2e.test.tsx`: the screen stories (every
  screen, light, dark and phone) and the seed's own check. They read the generated seed, so their
  frames show its durations, line numbers and sizes: the baselines in
  `web/tests/baselines/takumi/` match the seed they were recorded with. After regenerating the
  seed, re-record them with `UPDATE_SCREENS=1 vp run test:console-e2e` and review the changed
  PNGs.
