# @highalch/studio

Watch HighAlch explorations in your browser while they run. Install `@highalch/studio` in your
project, then run:

```sh
highalch studio --open -- vp test
```

The CLI prints a local link at `http://127.0.0.1:4983/` and `--open` opens it. The grid
shows each exploration shard's progress, current step, outcome, and latest painted screen.
Open a tile to see its sequences, story steps, and any shrunk failure. The relay keeps results
in memory, so opening or reloading the page after the tests finish shows the run so far.
The bundled viewer works offline. The CLI also prints a hosted alternative.

Explorations with a screen configured with `Takumi.frames()` stream the real painted PNG after
each step by default so you can see the UI evolve. Set `HIGHALCH_STREAM_FRAMES=replay` for failure
replays only, or pass `--no-frames` to skip painting for streaming and reduce test overhead.
Explorations without a painter still show steps and statuses. Standalone story runs do not
emit stream events.

- `--port n` chooses the loopback port. Use `0` for an available port.
- `--concurrency n` starts `n` shards under the same `HIGHALCH_RUN` and sets `HIGHALCH_SHARD=i/n`.
- `--exit` stops the relay when the command ends. By default Ctrl+C stops the relay after you
  finish browsing. The CLI uses the worst exit code across shards.
- With no command, the CLI prints the variables for a runner to stream to it.

The relay listens only on 127.0.0.1 and checks the Host and watcher Origin. Keep the printed
link private. Its fragment carries the view token, which the viewer sends as a WebSocket
subprotocol. The relay accepts viewing from its own address and studio.highalch.dev by default.
Test processes open sessions with `HIGHALCH_STREAM_TOKEN` and stream with a separate session
token. The view token grants read access only.

Use `relay()` to start the relay from a custom runner. Its `local` property is the local
viewer link and `link` is the hosted alternative.
