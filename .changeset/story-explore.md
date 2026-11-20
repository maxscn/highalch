---
"@lowalch/tanstack-db": patch
"@highalch/story": patch
---

Rules, explorations and forms. `Explore.rule("a sentence", { at, reads, holds })` replaces invariants (`story.with({ rules })`, `Db.rules`, `LowAlchDb.rules`), checked after every step, at rest or at the end, with typed readers (`Db.rows`, `Db.commands`, `Machine.snapshot`, `Form.state`, `Form.all`). `Explore.run` tries every sequence of up to `depth` moves of its sources (then seeded walks), captures nothing while exploring, and on a failure shrinks the sequence and replays it once with a trace and frames, as a story to paste. `story.with({ trace: true })` keeps a reviewed text snapshot of a story. `@highalch/story/tanstack-form` (`Form`) types into and submits the app's own `formOptions` forms, found through the `highalch()` Vite plugin (`@highalch/story/vite`) with no wiring in the app, and `Form.typing` makes typing an exploration's source. Commands the app sends itself are recorded like a story's own.
