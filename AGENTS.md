# Using Vite+, the Unified Toolchain for the Web

This project uses Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown,
Oxlint and Oxfmt. Vite+ wraps runtime management, package management and frontend tooling in a
single global CLI called `vp`. Run `vp help` for its commands and `vp <command> --help` for one of
them. Docs: `node_modules/vite-plus/docs` (when shipped) or https://viteplus.dev/guide/.

## Built-in commands vs scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script. Scripts cannot
overwrite built-ins, so `vp test` and `vp run test` may differ. The root scripts are:

- `vp run build`: `vp pack` in each package (tsdown; ESM `.mjs` and `.d.mts` in `dist`)
- `vp run typecheck`: `tsc` (TypeScript 7) over `packages/tanstack-db`, `packages/story` and the root project (`fixtures`, `scripts`)
- `vp run check:patterns`: `scripts/check-patterns.ts`, the packages' import boundaries
- `vp run test`: `vp test --maxWorkers=2`

## Review checklist

- [ ] Run `vp install` after pulling and before starting. Never hand-edit `pnpm-lock.yaml`.
- [ ] Format each completed edit batch with `vp fmt <edited files>`.
- [ ] Run `vp check`, `vp run check:patterns`, `vp run typecheck` and `vp test --maxWorkers=2`.
- [ ] Run `vp run build` when an entry, export or dependency changes.
- [ ] If setup or package-manager behaviour looks wrong, run `vp env doctor`.

This is a shared machine: run builds, type checks and tests one after another, never in
parallel, and start no dev servers.

# Conventions

- **Packages.** Two npm scopes in one workspace. LowAlch (`@lowalch/*`) converts alchemy
  Domain primitives for other infrastructure; HighAlch (`@highalch/*`) verifies apps built on
  them. `@lowalch/tanstack-db` is the core (`.`, `./server`, `./react`, `./xstate`,
  `./internal`). `@highalch/story` is the test kit (`.`, `./tanstack-db`, `./lowalch`, `./tanstack-form`,
  `./xstate`, `./screen`, `./takumi`, `./stream`, `./vite`, and the internal `./react-form`). Shared
  versions live in the `catalog` of `pnpm-workspace.yaml`. Peer versions are pinned exactly.
- **Effect v4** (`effect` 4.1.4, matching `@alchemy.run/domain` 2.0.0-beta.87). Shared code uses
  native guards, `Option` and `Match` instead of ternaries. Preserve narrowing and lazy
  execution. JSX keeps ordinary conditional rendering.
- **Terse names, namespaces for context.** Consumers write `import * as LowAlch from
  "@lowalch/tanstack-db"` and call `LowAlch.collection`, `LowAlch.make`, `LowAlch.match`. Stories
  use `import * as Story from "@highalch/story"` for the runner and the Domain's steps, and the
  adapters' namespaces from their entries: `Db` (`./tanstack-db`), `LowAlchDb` (`./lowalch`), `Machine` (`./xstate`),
  `Screen` (`./screen`). Do not add self-namespace projections.
- **No React `useEffect`** (nor `useLayoutEffect` or `useInsertionEffect`). Lifetimes are
  native external-store subscriptions (`useSyncExternalStore`) and callback refs.
- **Boundaries** (`vp run check:patterns`):
  - Only `@lowalch/tanstack-db/xstate` and `@highalch/story/xstate` import `xstate` and `@xstate/effect`.
  - Only `@highalch/story/screen` imports `happy-dom`, `react-dom`, `@effect/atom-react` and
    `node:` files (the runner keeps its traces and replays with `node:fs`, `node:path` and
    `node:url`); only `@highalch/story/takumi` (a screen painter) imports `takumi-js`.
  - `@lowalch/tanstack-db` never imports `@highalch/story`.
  - Only `@highalch/story/tanstack-form` imports `@tanstack/react-form`; stories find the app's
    forms through the `highalch()` Vite plugin (`@highalch/story/vite`), never a hook in the app.
  - No module exports `then` (`import()` would treat the module as a thenable and hang): put `then`
    on a namespace object (`Db.then`, `Machine.then`, `Form.then`).
  - The story runner (`@highalch/story`'s root) imports neither TanStack DB nor LowAlch;
    `@highalch/story/tanstack-db` never imports LowAlch; only `./lowalch` and `./xstate` do.
- **Internals.** `@highalch/story` reaches core internals only through `@lowalch/tanstack-db/internal`.
  That entry is unstable and outside semver. Never import another package's `src` by a relative
  path.
- **Reads and writes.** Reads use TanStack DB's stock `useLiveQuery` over a declaration's subset
  and render with `match(res).on(...)`. Declare entity reads with a bare query or `read(Query)`.
  Select wrapped rows with `.rows(select)` and set membership with `.where(rule)`, `.one(rule)`
  or `.all()`. Do not add hooks of ours. Commands take their input only and return TanStack DB
  transactions.
- **Suspense.** `Loading: LowAlch.Suspend` suspends a stock `useLiveQuery` read to the nearest
  `<Suspense>`; typed errors stay `match` branches. It is not a hook and needs no React import.
- **Comments and errors** name the core as LowAlch (`LowAlch.Defect`, "No LowAlch client is
  active") and the story kit as HighAlch.

## Tests

- Express tests as observable `f(state, action) => next state` transitions. For data and the
  machines over it, write them as stories: `Story.make(LowAlchDb.memory(...))` hosts the Domain in
  memory with real clients. Domain steps (`Story.given`, `Story.remote`, the transport's faults), data steps
  (`Db.when`, `Db.then`, `Db.settled`, `Db.rejected`, ...) and machine steps (`Machine.given` stepped purely, `Machine.start` running) compose in one
  story. `explore` generates interleavings checked against `Db.rules`.
- `packages/examples` (`@highalch/examples`, private) holds bugs a story catches: each a broken
  and an approved variant of a view, machine or form, one story run against both, both variants'
  frames as reviewed baselines (`packages/examples/tests/baselines/takumi/`). Other tests import
  its components, machines and forms by its package name as fixtures.
- Shared example Domains and views live in `fixtures/` (`notebook.ts`, `ledger.ts`, `notes.ts`,
  `editor.ts`, `note-list.tsx`). They import `@lowalch/*` and `@highalch/*` like a consumer does.
- Tests run from source. The aliases in `vite.config.ts` and the `paths` in
  `tsconfig.base.json` point `@lowalch/*` and `@highalch/*` at `src`, so a test never needs a build. Keep the two
  lists in sync when adding an entry.
- **Traces** (`packages/story/tests/traces/*.trace.txt`) are reviewed text snapshots of traced
  stories, written with the same `UPDATE_SCREENS=1` run as screens; review the diff and keep them
  with the change. Explorations' replays write theirs under `artifacts/explore` (ignored).
- **Screen baselines** (`packages/story/tests/baselines/<painter>/`) are reviewed PNGs. Write them only with
  `UPDATE_SCREENS=1 vp test packages/story/tests/screen.transition.test.tsx`, open the changed
  PNGs to review them, and keep them with the change. A normal run compares pixels exactly. The
  filmstrips go to `packages/story/artifacts/` (ignored).
- Releases and CI follow the supply-chain rules in the README's Releasing section: actions pinned to commit SHAs, no `pull_request_target`, no `id-token: write` in a job that installs dependencies, and the pnpm policies in `pnpm-workspace.yaml` stay on. Never add an npm token.
