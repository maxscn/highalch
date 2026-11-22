---
"@highalch/stream": patch
"@highalch/studio": patch
---

The stream goes over one WebSocket per session: events in batches and frames as binary messages, in order, acknowledged by the app and sent again after a reconnect. Opening a session is still the one request carrying the ingest token (or GitHub OIDC); the socket carries the session's token as a subprotocol. `@highalch/studio` adds `highalch studio [--concurrency n] -- <test command>`: a relay on 127.0.0.1 that receives the stream and passes it to https://studio.highalch.dev in the browser, so a run is watched live with nothing sent to a server; it checks Host, Origin and a token on every request.
