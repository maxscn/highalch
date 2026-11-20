---
"@highalch/tanstack-db": patch
"@highalch/story": patch
---

`command.result(input)` is a promise again: await it for `Committed | Unconfirmed | E` where there is no Effect, such as a React transition or a form's submit. It never rejects for a typed error; a defect rejects, as does a call on a closing or closed client. Breaking: it is no longer an Effect, so drop the `Effect.runPromise` around it; Effect code uses `command.effect(input)`, with the typed error in the error channel.
