# Using Vite+, the Unified Toolchain for the Web

This project uses Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown,
Oxlint and Oxfmt. Vite+ wraps runtime management, package management and frontend tooling in a
single global CLI called `vp`. Run `vp help` for its commands and `vp <command> --help` for one of
them. Docs: `node_modules/vite-plus/docs` (when shipped) or https://viteplus.dev/guide/.

## Built-in commands vs scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script. Scripts cannot
overwrite built-ins, so `vp test` and `vp run test` may differ. The root scripts are:

- `vp run build`: `vp pack` in each package (tsdown; ESM `.mjs` and `.d.mts` in `dist`)
- `vp run typecheck`: `tsc` (TypeScript 7) over `packages/db`, `packages/story` and the root project (`fixtures`, `scripts`)
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

- **Packages.** `@highalch/db` is the core (`.`, `./server`, `./react`, `./xstate`,
  `./internal`). `@highalch/story` is the test kit (`.`, `./xstate`, `./screen`). Shared
  versions live in the `catalog` of `pnpm-workspace.yaml`. Peer versions are pinned exactly.
- **Effect v4** (`effect` 4.1.4, matching `@alchemy.run/domain` 2.0.0-beta.87). Shared code uses
  native guards, `Option` and `Match` instead of ternaries. Preserve narrowing and lazy
  execution. JSX keeps ordinary conditional rendering.
- **Terse names, namespaces for context.** Consumers write `import * as HighAlch from
  "@highalch/db"` and call `HighAlch.collection`, `HighAlch.make`, `HighAlch.match`. Stories
  use `import * as Story from "@highalch/story"`. Do not add self-namespace projections.
- **No React `useEffect`** (nor `useLayoutEffect` or `useInsertionEffect`). Lifetimes are
  native external-store subscriptions (`useSyncExternalStore`) and callback refs.
- **Boundaries** (`vp run check:patterns`):
  - Only `@highalch/db/xstate` and `@highalch/story/xstate` import `xstate` and `@xstate/effect`.
  - Only `@highalch/story/screen` imports `takumi-js`, `happy-dom`, `react-dom` and `node:` files.
  - `@highalch/db` never imports `@highalch/story`.
- **Internals.** `@highalch/story` reaches core internals only through `@highalch/db/internal`.
  That entry is unstable and outside semver. Never import another package's `src` by a relative
  path.
- **Reads and writes.** Reads use TanStack DB's stock `useLiveQuery` over a declaration's subset
  and render with `match(res).on(...)`. Do not add hooks of ours. Commands take their input only
  and return TanStack DB transactions.
- **Comments and errors** name the package as HighAlch (`HighAlch.Defect`, "No HighAlch client
  is active").

## Tests

- Express tests as observable `f(state, action) => next state` transitions. For data and the
  machines over it, write them as stories: `Story.make(Story.memory(...))` hosts the Domain in
  memory with real clients. Data steps (`given`, `when`, `shows`, `state`, `settled`, `rejected`,
  ...) and machine steps (`Machine.given` stepped purely, `Machine.start` running) compose in one
  story. `explore` generates interleavings checked against `Story.invariants`.
- Shared example Domains and views live in `fixtures/` (`notebook.ts`, `ledger.ts`, `notes.ts`,
  `editor.ts`, `note-list.tsx`). They import `@highalch/*` like a consumer does.
- Tests run from source. The aliases in `vite.config.ts` and the `paths` in
  `tsconfig.base.json` point `@highalch/*` at `src`, so a test never needs a build. Keep the two
  lists in sync when adding an entry.
- **Screen baselines** (`packages/story/tests/baselines`) are reviewed PNGs. Write them only with
  `UPDATE_SCREENS=1 vp test packages/story/tests/screen.transition.test.tsx`, open the changed
  PNGs to review them, and keep them with the change. A normal run compares pixels exactly. The
  filmstrips go to `packages/story/artifacts/` (ignored).
