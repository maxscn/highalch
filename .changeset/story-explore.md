---
"@lowalch/tanstack-db": patch
"@highalch/story": patch
"@highalch/explore": patch
---

Rules, explorations and forms. `Story.rule("a sentence", function* ({ step }) { … }, { at })` replaces invariants (`story.with({ rules })`, `Db.rules`, `Alchemy.rules`), checked after every step, at rest or at the end. A rule yields what it reads, when it gets there (`yield* Db.rows(list)`, `Db.commands`, `Machine.snapshot`, `Form.state`, `Form.all`; `yield* Story.before(reader)` for its value at the previous check), and a failure lists each read by name. `Explore.run` (`@highalch/explore`) tries every sequence of up to `depth` moves of its sources (then seeded walks), captures nothing while exploring, and on a failure shrinks the sequence and replays it once with a trace and frames, as a story to paste. `story.with({ trace: true })` keeps a reviewed text snapshot of a story. `@highalch/tanstack-form` (`Form`) types into and submits the app's own `formOptions` forms, found through the `highalch()` Vite plugin (`@highalch/tanstack-form/vite`) with no wiring in the app, and `Form.typing` makes typing an exploration's source. Commands the app sends itself are recorded like a story's own.
