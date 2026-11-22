# Migrating Assay to HighAlch Console

The Console was built in a separate repository (Assay) with HighAlch as a submodule; it now
lives in HighAlch's repository under `console/` (see the [README](../README.md)). Paths below are
the new ones. Phase 3 is not part of the move: story reports are not in `@highalch/story` yet, so
the Console keeps its own copy of the `story.json` schema (`@highalch/console-client/StoryReport`).

Status: phases 0–2 done (2026-11-20). The Foldkit app, Pleat and `console-protocol` are retired;
the React app is `console/web`. Its fuzz, trace and subject screens are placeholders until
fuzzing returns. Phase 3 (story reports in HighAlch) is next. Decisions marked ✓ were made by the
product owner; do not revisit them.

Assay becomes **HighAlch Console**: the platform that hosts and shows HighAlch stories (`story.json`, the format in `@highalch/console-client/StoryReport`), built on HighAlch itself.

## Decisions

| Question                | Choice                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                    | ✓ "HighAlch Console" in the UI; packages `@highalch/console-*` (`console-domain`, `console-server`, `console-web`, `console-client`, `console-fuzz`, `console-playwright`). Repository folder unchanged.                                                                                          |
| HighAlch source         | ✓ Git submodule `references/highalch` (`maxscn/highalch`, pinned to `fbf52f3`). Changes to HighAlch are made there on a branch and upstreamed. Superseded by the move: the Console is in HighAlch's repository (`console/`) and links its packages from source.                                   |
| What runs on HighAlch   | ✓ Everything. Reads are HighAlch `Rows` synced into TanStack DB; writes are Domain commands.                                                                                                                                                                                                      |
| Public REST API         | ✓ Dropped. CI tools (uploader, Playwright reporter, fuzz reporter, GitHub Action) call the Domain Api through its own client. OpenAPI goes away.                                                                                                                                                  |
| Frontend                | ✓ React on **TanStack Start**, **Tailwind + shadcn/ui on Base UI** components. Foldkit, `@foldkit/ui` and Pleat are removed once the React app replaces every screen.                                                                                                                             |
| Tests                   | ✓ Rewritten as HighAlch stories as each area moves; the console then shows its own stories.                                                                                                                                                                                                       |
| CI-facing names         | ✓ Prefix `highalch`: env `HIGHALCH_API_KEY` / `HIGHALCH_URL` / `HIGHALCH_PROJECT`, output dir `.highalch/`, annotations `highalch:page\|part\|component`, API keys `highalch_live_…`, OIDC audience `highalch`, cookie `highalch_session`, storage key `highalch:theme`, log prefix `[highalch]`. |
| Reporter exports        | ✓ `ConsoleReporter` (Playwright) and `Console.reporter` (fuzz).                                                                                                                                                                                                                                   |
| Upload orchestration    | ✓ In the domain: composite commands and policies (e.g. `DeclareArtifacts` answers with signed PUT links); the domain's `Storage` service gains presign. The server only provides R2.                                                                                                              |
| Command targets         | ✓ Every command carries its target id in its input (e.g. `IssueApiKey { project, label }`).                                                                                                                                                                                                       |
| Result items in R2      | ✓ A domain query authorises and answers short-lived signed GET links; the browser fetches the JSON from R2.                                                                                                                                                                                       |
| Phase 1 choices         | ✓ Kept as built: `ConsoleSystemApi` (in-process, System caller), GitHub OIDC token on every CI call (no exchange, no run tokens), collections declared in console-domain, one `OrganizationChanges` feed per organisation for members only.                                                       |
| Result row pricing      | ✓ Charged rows = max(reported count, ceil(bytes / minBytesPerRow)) with minBytesPerRow ≈ 1 KB; server work on items is capped at the charged count; result bytes also count as uploaded bytes.                                                                                                    |
| CI organisation         | ✓ A `Credential` query answers {org, project, context} for an API key or GitHub OIDC caller.                                                                                                                                                                                                      |
| Checkout and portal     | ✓ Owner-only `CheckoutLink` / `PortalLink` queries backed by a `Payments` external system (Stripe via @alchemy.run/stripe), plus a policy that creates the Stripe customer.                                                                                                                       |
| Rate limits             | ✓ Fixed budgets in the Worker per credential (API key, OIDC repository, session, IP); 429 before ConsoleApi.                                                                                                                                                                                      |
| Auth                    | ✓ Better Auth through alchemy's documented integration (@alchemy.run/better-auth); fill gaps with the simplest working choice and note it.                                                                                                                                                        |
| Sidebar                 | ✓ Stories, Runs, Pull requests, Fuzzing, Settings. Schemas returns with fuzzing.                                                                                                                                                                                                                  |
| Story uploads           | ✓ A run kind `stories`, with story counts (passed, failed, frames changed) in the run summary; a run with failed stories is not Passed.                                                                                                                                                           |
| Story storage and price | ✓ The model keeps one row per story (name, status, counts); per-step detail stays in `story.json` in R2, read through download links. A story costs about one results batch.                                                                                                                      |

## Target shape

```
console/domain            Domain model: aggregates, commands, policies (as today), plus
                          HighAlch Feeds, Rows and Projections for every read the UI makes;
                          one Domain Api served to browsers and CI.
console/client            The Domain Api client for CI (Effect), with API-key and GitHub OIDC
                          credentials. Replaces @highalch/console-protocol + @highalch/console-client.
console/playwright, console/fuzz
                          Reporters on console-client (unchanged behaviour).
console/server            Cloudflare Worker (alchemy.run.ts): hosts the Domain Api (WebSocket
                          for the web app, HTTP for CI), Better Auth, Stripe webhooks, R2
                          signed uploads. No behaviour of its own: it hosts and adapts.
console/web               TanStack Start + React + Tailwind/shadcn (Base UI). Collections from
                          @lowalch/tanstack-db, rendered with `match`; stories with
                          @highalch/story, screens with @highalch/story/screen.
packages/*                HighAlch, linked from source (vite alias + tsconfig paths).
```

What stays HTTP that is not "REST": Better Auth's routes, Stripe's webhook, and R2 signed PUT
URLs for blobs. These are integrations, not a public API.

## Reads → Rows

Each read the UI makes becomes a `Rows` entity on a `Feed`, scoped by organisation (or project
where access is per project), and is exposed to the client as a `LowAlch.collection` with its
queries. Starting map (the domain agent refines it):

| Today (REST read / Domain view or stream)                                        | Becomes                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `listRuns`, `commitRuns`, `pullRuns`; `OrganizationRuns`, `RunIndex`             | `RunRows` on `OrganizationChanges`                                           |
| `getRun`, `RunDetail`                                                            | `RunRows` + `RunResultRows`                                                  |
| `listTests`, `listFuzzCases`, `listTraces`; `RunResults`, `RunArtifacts`         | `ResultRows` (paged parts stay in R2; rows hold the index)                   |
| `listSubjects`, `subjectHistory`; `ProjectSubjects`, `SubjectResults`            | `SubjectRows`, `SubjectResultRows`                                           |
| `listPulls`, `getPull`, `listCommits`; `SourceHistory`                           | `PullRows`, `CommitRows`                                                     |
| `me`, `listProjects`, `listMembers`, `listApiKeys`, `getBilling`; overview views | `OrganizationRows`, `ProjectRows`, `MemberRows`, `ApiKeyRows`, `BillingRows` |
| (new) story reports                                                              | `StoryRows`, `StoryStepRows` (from `story.json`)                             |

Writes (`createRun`, `declareArtifacts`, `postResults`, `completeRun`, `createProject`,
`updateProject`, API keys, billing checkout/portal) are the existing Domain commands, called
through the Domain Api. Authorisation stays in the domain (`Caller` middleware, `mayRead`).

## Versions

HighAlch pins `@alchemy.run/domain` **2.0.0-beta.87**, `@tanstack/db` / `@tanstack/react-db`
**1.0.0-rc.1.5**, React 19.2.7, `effect` 4.1.4. Assay moves every `@alchemy.run/*` and `alchemy`
to beta.87 (or the newest release all of them share that HighAlch accepts) and adds the HighAlch
catalog entries.

## Phases

0. **Foundation** (one agent, blocks the rest):
   rename packages and imports to `@highalch/console-*` and the UI name to "HighAlch Console";
   link HighAlch's `db` and `story` packages from source; bump alchemy to beta.87 and add
   the TanStack DB, XState, takumi catalog entries; repo-wide `vp check` and tests green on the
   current code.
1. **Domain** (one agent): Feeds/Rows/Projections per the map above; Domain Api exposing
   queries and streams for browsers and CI; domain tests rewritten as stories (`LowAlchDb.memory`).
2. In parallel, once 1's Rows exist:
   - **Server + CI client**: Worker and `alchemy.run.ts`, Domain Api over WebSocket/HTTP,
     credentials (session, API key, GitHub OIDC) as Domain middleware, R2 signed uploads,
     Stripe/Better Auth; `console-client` replaces protocol+client; reporters ported; protocol
     package deleted.
   - **Web**: new TanStack Start app with Tailwind + shadcn (Base UI), the design tokens from
     the design canvas as the Tailwind theme, every existing screen plus the story screens;
     stories with Screen frames for each screen. Then remove the Foldkit app and Pleat.
3. **Story reports**: implement story reports (`story.json`) in `@highalch/story`, and ingest
   `story.json` into `StoryRows`. The Console side (the uploader, `StoryRows`, the story pages)
   is built against its own copy of the schema; it moves to HighAlch's once that lands.

## Rules for every agent

- Effect primitives, tagged errors per failure reason, `@alchemy.run/domain` used properly:
  behaviour in the model, the server only hosts and adapts.
- Ask the orchestrator before any new interface or API decision not covered here.
- Commit nothing; do not switch branches.
