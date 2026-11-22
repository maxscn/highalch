# @highalch/studio

## 0.0.7

### Patch Changes

- b6b62e9: Bundle an offline viewer with `highalch studio`. Open the local link to follow exploration
  shards, painted screens, steps and shrunk failures. Pass `--open` to launch the viewer or
  `--no-frames` to stream without painted screens.
- f39d44a: The stream goes over one WebSocket per session: events in batches and frames as binary messages, in order, acknowledged by the app and sent again after a reconnect. Opening a session is still the one request carrying the ingest token (or GitHub OIDC); the socket carries the session's token as a subprotocol. `@highalch/studio` adds `highalch studio [--concurrency n] -- <test command>`: a relay on 127.0.0.1 that receives the stream and passes it to https://studio.highalch.dev in the browser, so a run is watched live with nothing sent to a server; it checks Host, Origin and a token on every request.
- Updated dependencies [d717c4e]
- Updated dependencies [52b54c1]
- Updated dependencies [6fd88c3]
- Updated dependencies [f39d44a]
  - @highalch/stream@0.0.7
