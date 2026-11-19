---
"@highalch/db": patch
"@highalch/story": patch
---

Stories reach the machine a mounted component reads through atoms: `Machine.mounted(atoms)` enters the actor of `createActorAtoms` as a running machine, `Screen.render` mounts under the story's atom registry, and the commands of machines there run on the story's client, recorded. Breaking: the XState peers are now `xstate` 6.0.0-beta.3 and `@xstate/effect` 1.0.0-beta.2, where an invoked command's `onError` receives an `EffectFailure`; read the typed rejection with the new `rejection(event.error)` from `@highalch/db/xstate`. `@highalch/story/screen` needs the new optional peer `@effect/atom-react`.
