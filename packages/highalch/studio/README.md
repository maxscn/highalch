# @highalch/studio

The HighAlch studio, on your machine: watch explorations live at
[studio.highalch.dev](https://studio.highalch.dev) while they run, with nothing sent to a server. A
relay on 127.0.0.1 receives what the tests stream (as the console would) and the page connects to
it from your browser.

```sh
highalch studio -- vp test                     # runs the tests, streaming to the studio
highalch studio --concurrency 4 -- vp test     # four shards of one run, side by side
highalch studio                                # just the relay: prints the variables to set
```

It prints a link, `https://studio.highalch.dev/#connect=http://127.0.0.1:4983&token=…`. The token is
in the fragment, which the browser never sends to studio.highalch.dev. The studio stays up after the
tests end, to be browsed, until Ctrl+C (`--exit` stops it with them). Its exit code is the worst
of the shards'.

- **What it sets.** Each shard runs with `HIGHALCH_STREAM_URL` and `HIGHALCH_STREAM_TOKEN` (the
  relay's), one `HIGHALCH_RUN` for all, and `HIGHALCH_SHARD=i/n` with `--concurrency n`. Tests
  change nothing.
- **Who gets in.** The relay listens on 127.0.0.1 only and answers only requests addressed to
  `127.0.0.1` or `localhost` (a page can't reach it by rebinding a name of its own). Test
  processes need the ingest token to open a session and the session's token to stream; pages
  need the view token, and only `https://studio.highalch.dev` and the relay's own address may watch.
  A page can't stream.
- **Browsers.** Chrome asks once whether studio.highalch.dev may reach your local network. Safari
  does not let an HTTPS page reach plain HTTP on localhost.
- **Memory.** The relay keeps the run in memory, so a page opened late (or reloaded) sees all of
  it. Stop it to let it go.

From code, `relay({ port })` starts one and returns its `url`, `ingest` and `view` tokens, `link`
and `close`.
