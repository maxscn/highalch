# @highalch/story

## 0.0.3

### Patch Changes

- 960b8fd: Stories reach the machine a mounted component reads through atoms: `Machine.mounted(atoms)` enters the actor of `createActorAtoms` as a running machine, `Screen.render` mounts under the story's atom registry, and the commands of machines there run on the story's client, recorded. `Screen.check(label, (container) => …)` asserts on the mounted DOM. Breaking: the XState peers are now `xstate` 6.0.0-beta.3 and `@xstate/effect` 1.0.0-beta.2, where an invoked command's `onError` receives an `EffectFailure`; read the typed rejection with the new `rejection(event.error)` from `@highalch/db/xstate`. `@highalch/story/screen` needs the new optional peer `@effect/atom-react`.
- Updated dependencies [960b8fd]
  - @highalch/db@0.0.3

## 0.0.2

### Patch Changes

- 49d16de: Add `HighAlch.Suspend`, a `match` `Loading` handler that suspends a stock `useLiveQuery` read to the nearest `<Suspense>` while typed errors stay branches.
- Updated dependencies [9831869]
- Updated dependencies [49d16de]
  - @highalch/db@0.0.2

## 0.0.1

### Patch Changes

- First release published from CI: MIT licence, public access, and peer ranges for effect, React, happy-dom and takumi.
- Updated dependencies
  - @highalch/db@0.0.1
