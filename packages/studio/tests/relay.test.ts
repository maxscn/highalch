import { createHash } from "node:crypto";
import { request } from "node:http";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import WebSocket from "ws";
import {
  bearer,
  connect,
  framed,
  subprotocol,
  unframed,
  Watched,
  type Settings,
} from "@highalch/stream";
import { parse, relay, studio, type Relay } from "@highalch/studio";

const running: Array<Relay> = [];

afterEach(async () => {
  vi.restoreAllMocks();

  for (const each of running.splice(0)) await each.close();
});

const started = async () => {
  const made = await relay({ port: 0 });

  running.push(made);

  return made;
};

const socketUrl = (made: Relay, path: string) => `${made.url.replace(/^http/, "ws")}${path}`;

/** Whether a socket opens, or how its upgrade was refused (`Unexpected server response: 403`). */
const opens = (socket: WebSocket) =>
  new Promise<string>((resolve) => {
    socket.once("open", () => {
      socket.close();
      resolve("open");
    });
    socket.once("error", (error) => resolve(error.message));
  });

/** A page watching the relay: every message it received, decoded, frames by their SHA-256. */
const watching = async (made: Relay) => {
  const socket = new WebSocket(socketUrl(made, "/v1/watch"), [subprotocol, bearer(made.view)], {
    origin: "https://highalch.studio",
  });
  const messages: Array<Watched> = [];
  const frames: Array<string> = [];

  socket.on("message", (data, binary) => {
    if (binary) {
      frames.push(unframed(new Uint8Array(data as Buffer)).image);

      return;
    }

    messages.push(Schema.decodeUnknownSync(Watched)(JSON.parse((data as Buffer).toString())));
  });

  await new Promise((resolve) => socket.once("open", resolve));

  return { socket, messages, frames };
};

const until = async (holds: () => boolean) => {
  for (let tries = 0; tries < 200 && !holds(); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));

  expect(holds()).toBe(true);
};

const settingsOf = (made: Relay, more: Partial<Settings> = {}): Settings => ({
  url: made.url,
  auth: { kind: "token", token: made.ingest },
  run: "run-1",
  shard: { index: 1, total: 1 },
  origin: {},
  frames: "every",
  ...more,
});

const startedEvent = (name: string) => ({
  type: "exploration" as const,
  exploration: name,
  name,
  shard: { index: 1, total: 1 },
  sequences: { total: 1, corpus: 0, checked: 1, sampled: 0, discovered: 0 },
  depth: 1,
  sources: [],
  rules: [],
  setup: [],
});

const png = (byte: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, byte]);

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("f(request) → only this machine's processes stream, only the studio's pages watch", () => {
  it("f(another Host, a wrong token, another origin, a page streaming) → refused", async () => {
    const made = await started();
    const port = new URL(made.url).port;

    // `fetch` can't set Host: a plain request can, as a page rebinding a name would.
    const session = (headers: Record<string, string>) =>
      new Promise<number | undefined>((resolve, reject) => {
        const sent = request(
          `${made.url}/v1/sessions`,
          { method: "POST", headers: { "content-type": "application/json", ...headers } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );

        sent.on("error", reject);
        sent.end(
          JSON.stringify({ protocol: 1, run: "r", shard: { index: 1, total: 1 }, origin: {} }),
        );
      });

    // A page that rebinds its own name to 127.0.0.1 still sends its own Host.
    expect(
      await session({ authorization: `Bearer ${made.ingest}`, host: `evil.example:${port}` }),
    ).toBe(403);
    expect(await session({ authorization: "Bearer wrong" })).toBe(401);
    // The view token watches; it opens no session.
    expect(await session({ authorization: `Bearer ${made.view}` })).toBe(401);
    expect(await session({ authorization: `Bearer ${made.ingest}` })).toBe(201);

    const watch = (token: string, origin?: string) =>
      opens(
        new WebSocket(socketUrl(made, "/v1/watch"), [subprotocol, bearer(token)], {
          ...(origin !== undefined && { origin }),
        }),
      );

    expect(await watch(made.view, "https://highalch.studio")).toBe("open");
    expect(await watch(made.view, made.url)).toBe("open");
    expect(await watch(made.view, "https://evil.example")).toContain("403");
    expect(await watch(made.ingest, "https://highalch.studio")).toContain("401");

    const opened = (await fetch(`${made.url}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${made.ingest}` },
      body: JSON.stringify({ protocol: 1, run: "r", shard: { index: 1, total: 1 }, origin: {} }),
    }).then((response) => response.json())) as { session: string; token: string };

    const stream = (token: string, origin?: string) =>
      opens(
        new WebSocket(
          socketUrl(made, `/v1/sessions/${opened.session}/socket`),
          [subprotocol, bearer(token)],
          { ...(origin !== undefined && { origin }) },
        ),
      );

    expect(await stream(opened.token)).toBe("open");
    expect(await stream(made.ingest)).toContain("401");
    // Pages watch; they never stream.
    expect(await stream(opened.token, "https://highalch.studio")).toContain("403");

    expect(made.link).toBe(
      `https://highalch.studio/#connect=${encodeURIComponent(made.url)}&token=${made.view}`,
    );
  });
});

describe("f(a process streaming, a page watching) → what is kept so far, then everything live", () => {
  it("f(events and frames, a page opened late, then more) → kept once each, in order", async () => {
    const made = await started();
    const offered: Array<ReadonlyArray<string>> = [];

    // Notes what each socket is offered: the session's token, never the ingest token.
    class Noted extends globalThis.WebSocket {
      constructor(url: string | URL, protocols?: string | Array<string>) {
        super(url, protocols);
        offered.push([protocols ?? []].flat());
      }
    }

    const sink = connect(settingsOf(made, { WebSocket: Noted }));
    const first = png(1);

    sink.send(startedEvent("card"));
    expect(await sink.frame(first)).toEqual(expect.objectContaining({ value: sha(first) }));
    // The same frame again is not sent again.
    await sink.frame(first);
    await sink.flush();

    const page = await watching(made);

    await until(() => page.messages.some((each) => each.type === "events"));
    expect(page.frames).toEqual([sha(first)]);
    expect(page.messages.map((each) => each.type)).toEqual(["session", "events"]);

    const second = png(2);

    await sink.frame(second);
    sink.send({ ...startedEvent("card"), name: "again" });
    await sink.close();

    await until(() => page.messages.some((each) => each.type === "closed"));
    expect(page.frames).toEqual([sha(first), sha(second)]);
    expect(
      page.messages.flatMap((each) =>
        each.type === "events" ? each.envelopes.map((envelope) => envelope.seq) : [],
      ),
    ).toEqual([1, 2]);
    expect(offered.flat().some((each) => each.includes(made.ingest))).toBe(false);
    expect(offered[0]?.[0]).toBe(subprotocol);

    page.socket.close();
  });

  it("f(the socket drops mid-stream) → it reconnects and sends what was not acknowledged, kept once", async () => {
    const made = await started();
    const sockets: Array<WebSocket | globalThis.WebSocket> = [];

    class Kept extends globalThis.WebSocket {
      constructor(url: string | URL, protocols?: string | Array<string>) {
        super(url, protocols);
        sockets.push(this);
      }
    }

    const sink = connect(settingsOf(made, { WebSocket: Kept }));
    const page = await watching(made);

    sink.send(startedEvent("one"));
    await sink.flush();

    // Dropped, not closed by the process: it opens another and goes on.
    sockets[0]?.close(4000, "dropped");
    await until(() => sockets.length === 2);
    sink.send(startedEvent("two"));
    sink.send(startedEvent("three"));
    await sink.close();

    await until(() => page.messages.some((each) => each.type === "closed"));
    expect(
      page.messages.flatMap((each) =>
        each.type === "events" ? each.envelopes.map((envelope) => envelope.event) : [],
      ),
    ).toMatchObject([{ exploration: "one" }, { exploration: "two" }, { exploration: "three" }]);

    page.socket.close();
  });

  it("f(a frame whose SHA-256 does not match it) → the socket is closed; nothing is kept", async () => {
    const made = await started();
    const opened = (await fetch(`${made.url}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${made.ingest}` },
      body: JSON.stringify({ protocol: 1, run: "r", shard: { index: 1, total: 1 }, origin: {} }),
    }).then((response) => response.json())) as { session: string; token: string };
    const page = await watching(made);
    const socket = new WebSocket(socketUrl(made, `/v1/sessions/${opened.session}/socket`), [
      subprotocol,
      bearer(opened.token),
    ]);

    await new Promise((resolve) => socket.once("open", resolve));

    const closed = new Promise<number>((resolve) => socket.once("close", resolve));

    socket.send(framed(sha(png(1)), png(2)));

    expect(await closed).toBe(1008);
    expect(page.frames).toEqual([]);

    page.socket.close();
  });

  it("f(a refused ingest token) → the stream turns off with one warning, never printing it", async () => {
    const made = await started();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sink = connect(settingsOf(made, { auth: { kind: "token", token: "hat_wrong" } }));

    sink.send(startedEvent("card"));
    await sink.flush();
    sink.send(startedEvent("card"));
    await sink.flush();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("answered 401");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("hat_wrong");
  });
});

describe("f(highalch studio …) → the relay, the link, and the command as shards", () => {
  it("f(flags) → what was asked; f(unknown flags) → the usage", () => {
    expect(parse(["studio", "--concurrency", "4", "--", "vp", "test"])).toEqual({
      port: 4983,
      concurrency: 4,
      exit: false,
      command: ["vp", "test"],
    });
    expect(() => parse(["studio", "--concurency", "4"])).toThrow(/unknown: --concurency/);
    expect(() => parse(["studio", "--concurrency", "0"])).toThrow(/at least 1/);
    expect(() => parse(["serve"])).toThrow(/usage: highalch studio/);
  });

  it("f(--concurrency 2 -- a command) → two shards of one run, streaming to the relay; the worst exit code", async () => {
    const lines: Array<string> = [];
    const envs: Array<Readonly<Record<string, string | undefined>>> = [];

    const { relay: made, code } = await studio(
      { port: 0, concurrency: 2, exit: true, command: ["vp", "test"] },
      {
        log: (line) => lines.push(line),
        run: async (command, env) => {
          envs.push(env);

          return envs.length - 1;
        },
      },
    );

    expect(code).toBe(1);
    expect(lines[1]).toBe(`Open ${made.link}`);
    expect(envs.map((env) => env.HIGHALCH_SHARD)).toEqual(["1/2", "2/2"]);
    expect(new Set(envs.map((env) => env.HIGHALCH_RUN)).size).toBe(1);
    expect(envs[0]).toMatchObject({
      HIGHALCH_STREAM_URL: made.url,
      HIGHALCH_STREAM_TOKEN: made.ingest,
    });
    // --exit: the relay stopped with the tests.
    expect(
      await fetch(`${made.url}/v1/sessions`, { method: "POST" }).then(
        () => "up",
        () => "stopped",
      ),
    ).toBe("stopped");
  });
});
