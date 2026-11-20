---
"@lowalch/tanstack-db": patch
"@highalch/story": patch
---

A `.where` or `.one` rule may read only what the entity's rows have. The feed gives a rule the entity's own rows, so a rule over rows that `.rows(...)` widened with extra fields compiled and then read `undefined`; it is now a type error on that declaration. A query whose answer is an array or `null` is accepted as a bare query.
