# Using Vite+, the Unified Toolchain for the Web

This project uses Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown,
Oxlint and Oxfmt. Vite+ wraps runtime management, package management and frontend tooling in a
single global CLI called `vp`. Run `vp help` for its commands and `vp <command> --help` for one of
them. Docs: `node_modules/vite-plus/docs` (when shipped) or https://viteplus.dev/guide/.

## Built-in commands vs scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script. Scripts cannot
overwrite built-ins, so `vp test` and `vp run test` may differ. The root scripts are:

- `vp run build`: `vp pack` in each package (tsdown; ESM `.mjs` and `.d.mts` in `dist`)
- `vp run typecheck`: `tsc` (TypeScript 7) over every package and the root project (`fixtures`, `scripts`)
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

- **Packages.** Two npm scopes in one workspace, each in its folder (`packages/lowalch/*`,
  `packages/highalch/*`). LowAlch (`@lowalch/*`) converts alchemy Domain primitives for other
  infrastructure; HighAlch (`@highalch/*`) verifies apps built on them, one package per
  integration:
  - `@lowalch/tanstack-db`: the core (`.`, `./server`, `./react`, `./xstate`, `./internal`).
  - `@highalch/story`: the runner, world, rules and the host interface (`.`, `./internal`).
  - `@highalch/tanstack-db` (`Db`), `@highalch/xstate` (`Machine`), `@highalch/screen`
    (`Screen`), `@highalch/takumi` (`Takumi`), `@highalch/tanstack-form` (`Form`; `./vite`,
    `./react-form`) and `@highalch/alchemy-domain` (`Alchemy`: the Domain hosted in memory with
    LowAlch clients, its steps and the feed rules).
  - `@highalch/explore` explores stories (`.`, `./xstate`), `@highalch/stream` streams them to an
    app (the protocol and its client), and `@highalch/studio` is the relay behind
    `highalch studio`.

  Shared versions live in the `catalog` of `pnpm-workspace.yaml`. Peer versions are pinned
  exactly. `@highalch/examples` is reached by the Vite alias only, never as a dependency: it
  depends on the packages whose tests use it.

- **Effect v4** (`effect` 4.1.4, matching `@alchemy.run/domain` 2.0.0-beta.87). Shared code uses
  native guards, `Option` and `Match` instead of ternaries. Preserve narrowing and lazy
  execution. JSX keeps ordinary conditional rendering.
- **Terse names, namespaces for context.** Consumers write `import * as LowAlch from
  "@lowalch/tanstack-db"` and call `LowAlch.collection`, `LowAlch.make`, `LowAlch.match`. Stories
  use `import * as Story from "@highalch/story"` for the runner, and each adapter's namespace from
  its package: `Db`, `Alchemy`, `Machine`, `Screen`, `Takumi`, `Form`, `Explore`. Do not add
  self-namespace projections.
- **No React `useEffect`** (nor `useLayoutEffect` or `useInsertionEffect`). Lifetimes are
  native external-store subscriptions (`useSyncExternalStore`) and callback refs.
- **Boundaries** (`vp run check:patterns`, which lists what each package may import):
  - `@highalch/story` imports only effect and the node files keeping traces: no data layer, no UI,
    no alchemy. Each integration is its own package.
  - Only `@highalch/alchemy-domain` and `@highalch/xstate` (LowAlch's commands) import alchemy or
    LowAlch; `@highalch/tanstack-db` works on plain TanStack DB.
  - Only `@lowalch/tanstack-db/xstate` and `@highalch/xstate` import `xstate` and `@xstate/effect`
    (and `@highalch/explore/xstate`, its model-based exploration).
  - Only `@highalch/screen` imports `happy-dom`, `react-dom` and `@effect/atom-react`; only
    `@highalch/takumi` imports `takumi-js`; only `@highalch/tanstack-form` imports
    `@tanstack/react-form`. Stories find the app's forms through the `highalch()` Vite plugin
    (`@highalch/tanstack-form/vite`), never a hook in the app.
  - `@lowalch/tanstack-db` never imports HighAlch; `@highalch/stream` imports only effect.
  - No module exports `then` (`import()` would treat the module as a thenable and hang): put `then`
    on a namespace object (`Db.then`, `Machine.then`, `Form.then`).
- **Internals.** A package reaches another's internals only through its `./internal` entry
  (`@lowalch/tanstack-db/internal`, `@highalch/story/internal`, `@highalch/tanstack-db/internal`,
  `@highalch/screen/internal`). Those entries are unstable and outside semver. Never import
  another package's `src` by a relative path.
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
  machines over it, write them as stories: `Story.make(Alchemy.memory(...))` hosts the Domain in
  memory with real clients. Domain steps (`Alchemy.given`, `Alchemy.remote`), the transport's faults, data steps
  (`Db.when`, `Db.then`, `Db.settled`, `Db.rejected`, ...) and machine steps (`Machine.given` stepped purely, `Machine.start` running) compose in one
  story, with rules (`Story.rule`) checked at their moments. `@highalch/explore` (`Explore.run`)
  tries every sequence of what can happen, checked against the same rules.
- `packages/highalch/examples` (`@highalch/examples`, private) holds bugs a story catches: each a broken
  and an approved variant of a view, machine or form, one story run against both, both variants'
  frames as reviewed baselines (`packages/highalch/examples/tests/baselines/takumi/`). Other tests import
  its components, machines and forms by its package name as fixtures.
- Shared example Domains and views live in `fixtures/` (`notebook.ts`, `ledger.ts`, `notes.ts`,
  `editor.ts`, `note-list.tsx`). They import `@lowalch/*` and `@highalch/*` like a consumer does.
- Tests run from source. The aliases in `vite.config.ts` and the `paths` in
  `tsconfig.base.json` point `@lowalch/*` and `@highalch/*` at `src`, so a test never needs a build. Keep the two
  lists in sync when adding an entry.
- **Traces** (`packages/highalch/xstate/tests/traces/*.trace.txt`) are reviewed text snapshots of traced
  stories, written with the same `UPDATE_SCREENS=1` run as screens; review the diff and keep them
  with the change. Explorations' replays write theirs under `artifacts/explore` (ignored).
- **Screen baselines** (`packages/highalch/takumi/tests/baselines/<painter>/`) are reviewed PNGs. Write them only with
  `UPDATE_SCREENS=1 vp test packages/highalch/takumi/tests/screen.transition.test.tsx`, open the changed
  PNGs to review them, and keep them with the change. A normal run compares pixels exactly. The
  filmstrips go to `packages/highalch/takumi/artifacts/` (ignored).
- Releases and CI follow the supply-chain rules in the README's Releasing section: actions pinned to commit SHAs, no `pull_request_target`, no `id-token: write` in a job that installs dependencies, and the pnpm policies in `pnpm-workspace.yaml` stay on. Never add an npm token.
