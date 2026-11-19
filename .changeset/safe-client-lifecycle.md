---
"@highalch/db": patch
---

Fix client shutdown so unanswered commands roll back at the deadline even if the endpoint
keeps running, paced transactions roll back immediately, and new reads on a closing client
fail with `HighAlch.ClientClosed`. Await the last feed's finalizer on subset cleanup. Run all
endpoints in the configured runtime context and honor explicit reloads on non-live clients.
